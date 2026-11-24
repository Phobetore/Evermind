"""What Evermind sends to an AI as a reply ceiling, and the room and the window it counts for it.

Pure: no database, no network. It is the one place where the way a reply is asked for is decided,
so that what a prompt keeps for the reply and what the server is told never drift apart.
"""

from dataclasses import dataclass
from typing import Literal

from ..providers.catalog import LOCAL_FAMILIES, Family, family_of

REPLY_ROOM = {"short": 512, "medium": 1024, "long": 2048}
# A connection with no ceiling has always kept 1024 for the reply, whatever length was asked;
# taking the asked length's room would change what an update reads of an installed AI.
UNSENT_RESERVE = 1024
# What the Anthropic template used to leave for thinking: 4096 sent, 1024 of it the story.
THINKING_ALLOWANCE = 3072
# Anthropic refuses a request with no ceiling, so its provider always sends at least this.
ANTHROPIC_FLOOR = 4096
# A way that leaves the reply's room to the AI: the most the prompt keeps for it.
OPEN_ROOM = 4096
# Nothing told, by a hosted service or an unknown server: the default Evermind has always used.
ASSUMED_WINDOW = 16384
# A server that loads a size of its own and has not said it: Ollama's documented default.
SIZE_UNTOLD = 4096

# The kinds of a read size the server really said (what it serves, what it is set to load, what
# was observed): they count as read. A maximum does not.
_TOLD = ("served", "configured", "observed")
# Under this a fixed ceiling cuts long replies short (the room a long reply needs).
_LONG_ROOM = REPLY_ROOM["long"]


def reply_room(conversation: dict | None, settings: dict) -> int:
    """The room a reply needs, for `auto`. This is the seam: until the ways of playing exist it
    follows the reply length alone. `None` is passed by the uses that have no conversation (the
    card assistant, the speed test)."""
    return REPLY_ROOM.get(settings.get("reply_length") or "medium", REPLY_ROOM["medium"])


def thinking_allowance(model: dict) -> int:
    """What a model that reasons is given on top of the reply, until it is measured."""
    return THINKING_ALLOWANCE


@dataclass(frozen=True)
class Window:
    tokens: int
    source: Literal["own", "read", "size_untold", "assumed"]


def window(model: dict, *, family: Family) -> Window:
    """How much the AI reads at once, as counted by the prompt budget."""
    own = model.get("context_own")
    if own is not None:
        return Window(own, "own")
    read = model.get("context_read")
    if read is not None and model.get("context_read_kind") in _TOLD:
        return Window(read, "read")
    if family in LOCAL_FAMILIES:
        # Its maximum is not what it loads: count the size it documents unless the maximum is lower.
        return Window(SIZE_UNTOLD if read is None else min(read, SIZE_UNTOLD), "size_untold")
    if read is not None:
        return Window(read, "read")
    return Window(ASSUMED_WINDOW, "assumed")


@dataclass(frozen=True)
class Ceiling:
    sent: int | None   # max_tokens in the request; None = not sent (Anthropic's provider then sends 4096)
    reserve: int       # what the prompt budget keeps for the reply


def _at_most(value: int, out: int | None) -> int:
    return value if out is None else min(value, out)


def ceiling(model: dict, *, anthropic: bool, family: Family, room: int | None,
            window: int | None = None, allowance: int | None = None) -> Ceiling:
    """`anthropic` is the service's provider; `room` is `reply_room(...)`, None for a way that
    leaves the room to the AI. `window` is what the AI is counted to read: given, `auto` never
    keeps (or sends) more than half of it. `allowance` is the room for a model's thinking,
    `thinking_allowance(model)` when not given."""
    mode = model.get("reply_cap_mode") or "auto"
    if mode == "fixed":
        tokens = model["reply_cap_tokens"]
        return Ceiling(tokens, tokens)
    if mode == "unsent":
        return Ceiling(None, UNSENT_RESERVE)
    if allowance is None:
        allowance = thinking_allowance(model)
    got = _auto(model, anthropic=anthropic, family=family, room=room, window=window,
                allowance=allowance)
    if window is None:
        return got
    # A reply that takes the whole window leaves the engine only its floor for the story.
    half = window // 2
    return Ceiling(None if got.sent is None else min(got.sent, half), min(got.reserve, half))


def _auto(model: dict, *, anthropic: bool, family: Family, room: int | None,
          window: int | None, allowance: int) -> Ceiling:
    out = model.get("output_read")
    if room is None:
        # No room asked: nothing is sent but what Anthropic requires, and the prompt keeps what
        # a long reply could take, never more than a quarter of what the AI reads.
        kept = min(b for b in (OPEN_ROOM, out, None if window is None else window // 4)
                   if b is not None)
        return Ceiling((ANTHROPIC_FLOOR if out is None else out) if anthropic else None, kept)
    if model.get("reasons") == 1:
        # Its thinking comes out of the same ceiling: leave room for it, or send none.
        reserve = _at_most(room + allowance, out)
        if anthropic:
            # What the request may write is all kept: the prompt and the reply must fit together.
            sent = _at_most(max(room + allowance, ANTHROPIC_FLOOR), out)
            return Ceiling(sent, sent)
        return Ceiling(None, reserve)
    if anthropic:
        sent = _at_most(max(room, ANTHROPIC_FLOOR), out)
        return Ceiling(sent, sent)
    if family == "openai":
        # Its models that reason refuse max_tokens, and its list does not say which do: send none.
        return Ceiling(None, _at_most(room, out))
    sent = _at_most(room, out)
    return Ceiling(sent, sent)


def call_for(model: dict, service: dict, *, room: int) -> dict:
    """What a provider and the services take for one use of an AI."""
    provider = service["provider"]
    base_url = service["base_url"]
    family = family_of(provider, base_url, service.get("family") or "generic",
                       service.get("family_url"))
    counted = window(model, family=family)
    cap = ceiling(model, anthropic=provider == "anthropic", family=family, room=room,
                  window=counted.tokens)
    return {
        "provider": provider,
        "base_url": base_url,
        "api_key": service["api_key"],
        "model": model["model"],
        "temperature": model.get("temperature"),
        "top_p": model.get("top_p"),
        "frequency_penalty": model.get("frequency_penalty"),
        "presence_penalty": model.get("presence_penalty"),
        "max_tokens": cap.sent,
        "context_size": counted.tokens,
        "reserve": cap.reserve,
        "model_id": model["id"],
        "model_name": model["name"],
        "reasons": model.get("reasons"),
    }


def for_engine(call: dict) -> dict:
    """The engine reads max_tokens as the room it keeps, not as what is sent."""
    return {**call, "max_tokens": call["reserve"]}


Notice = Literal["follow_server", "let_evermind"]


def notices(model: dict) -> list[Notice]:
    """What the person may want to change after an update, or after typing a figure."""
    if model.get("notices_kept"):
        return []
    found: list[Notice] = []
    own = model.get("context_own")
    if (own is not None and model.get("context_read_kind") in ("served", "configured")
            and own != model.get("context_read")):
        found.append("follow_server")
    if model.get("reply_cap_mode") == "fixed" and model["reply_cap_tokens"] < _LONG_ROOM:
        found.append("let_evermind")
    return found
