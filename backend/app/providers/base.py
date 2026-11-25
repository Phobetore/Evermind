"""What every provider shares: the request to a model's server, its stream, and how it fails."""

import json
import re
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing
from dataclasses import dataclass, field, fields, replace
from typing import Literal

import httpx

from ..errors import MODEL_ERROR, MODEL_NO_CREDIT, MODEL_ONLY_THOUGHT, MODEL_WITHHELD, AppError
from ..prompting.engine import PromptPayload

# Local generation can be slow: generous read timeout, snappy connect timeout.
# read is per-chunk, but the FIRST token after a long prompt-eval on big
# CPU-offloaded models (70B hybrid) can take many minutes — hence 900s.
DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=900.0, write=30.0, pool=30.0)
# A list of models is not a generation: no first word to wait minutes for, so 30s between two
# pieces is already a server that has stopped sending. The whole read has its own bound (catalog).
LIST_DELAYS = httpx.Timeout(connect=10.0, read=30.0, write=30.0, pool=30.0)

# How a model's server failed, besides MODEL_ERROR, which is its own complaint.
UNREACHABLE = "unreachable"
CONNECTION_LOST = "model_connection_lost"
AUTH_REFUSED = "model_auth_refused"
MODEL_NOT_FOUND = "model_not_found"
RATE_LIMITED = "model_rate_limited"
NO_TEXT = "model_no_text"
# A list of models that kept arriving past the whole delay, which "unreachable" would misname.
LIST_TIMEOUT = "list_timeout"
# What a server says of a request it will not take as written, as opposed to a key or a limit.
REFUSED_AS_WRITTEN = (400, 404, 422)


# How a model stopped when it ran out of room, whatever its server calls it.
STOPPED_FOR_LENGTH = "length"


@dataclass
class ProviderEvent:
    type: Literal["delta", "thought", "done"]
    # On "delta": the reply. On "thought", only inside a provider: the reasoning, which
    # stream_chat turns into its count before it leaves.
    text: str = ""
    usage: dict | None = None
    # On "done": STOPPED_FOR_LENGTH, else the server's own word for why the model stopped, if it gave one.
    stop: str | None = None
    # On "thought": how many characters of reasoning arrived. Only the count: what a model thinks is
    # not its answer, and nothing keeps it.
    count: int = 0


@dataclass
class CallFigures:
    """What a model's server said of one request, as it arrived: its own counts and names, kept
    whatever became of the reply, so that a stop or an error leaves what came readable."""

    usage: dict = field(default_factory=dict)  # merged field by field (see take_usage)
    generation_id: str | None = None   # the chunk `id` (OpenRouter `gen-…`), Anthropic's `message.id`
    model_served: str | None = None    # the chunk's `model`
    upstream: str | None = None        # OpenRouter's `provider`
    stop: str | None = None            # the stop reason as the server gave it, before any mapping
    chars_out: int = 0                 # visible characters received
    thought_chars: int = 0             # reasoning characters received
    sent: bool = False                 # the status line came back: the request reached the server
    opened: bool = False               # any stream event seen
    usage_final: bool = False          # a final count arrived
    on_id: Callable[["CallFigures"], None] | None = None  # set by whoever records the call; called
                                       # once when generation_id is first known; ignored if None

    def reset(self) -> None:
        """Back to nothing known, for a new request. The same object, so that whoever holds it,
        or set on_id, hears of the request that answers."""
        for each in fields(self):
            if each.name != "on_id":
                setattr(self, each.name, each.default_factory() if each.name == "usage"
                        else each.default)

    def take_usage(self, usage: object, final: bool) -> None:
        """A server's counts, field by field: the last value given wins, a None never erases one,
        and nothing is added up (Anthropic's last count already holds the first)."""
        if not isinstance(usage, dict) or not usage:
            return
        self.usage.update({key: value for key, value in usage.items() if value is not None})
        self.usage_final = self.usage_final or final

    def take_names(self, generation_id: object = None, model: object = None,
                   upstream: object = None) -> None:
        """The names the server gave its answer: the first given of each is kept."""
        if self.model_served is None and isinstance(model, str) and model:
            self.model_served = model
        if self.upstream is None and isinstance(upstream, str) and upstream:
            self.upstream = upstream
        if self.generation_id is None and isinstance(generation_id, str) and generation_id:
            self.generation_id = generation_id
            if self.on_id is not None:
                self.on_id(self)


_SURROGATE = re.compile("[\ud800-\udfff]")


class WholeCharacters:
    """Puts back together a character that a server split across two events.

    A server that writes each token as JSON on its own can send an emoji in two halves,
    "\\ud83d" at the end of one event and "\\ude00" at the start of the next, and each event
    is read on its own. A high half that ends a piece is held until the next one says
    whether its low half follows; a half that has no pair becomes U+FFFD, as JavaScript's
    toWellFormed does. A high half still held when the text ends is dropped with it.
    """

    def __init__(self):
        self.held = ""

    def take(self, text: str) -> str:
        text, self.held = self.held + text, ""
        if not _SURROGATE.search(text):
            return text
        if "\ud800" <= text[-1] <= "\udbff":
            text, self.held = text[:-1], text[-1]
        return well_formed(text)


def well_formed(text: str) -> str:
    """The text with each half of a character that has no pair turned into U+FFFD."""
    if not _SURROGATE.search(text):
        return text
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")


class ProviderError(AppError):
    """A model's server that failed: ``message`` is what it said, or the address it could not be
    reached at, and ``status`` the error status it answered with, if it did."""

    def __init__(self, message: str, kind: str = MODEL_ERROR, status: int | None = None):
        super().__init__(message, 502, kind=kind)
        self.status = status


def words_of(said: object, api_key: str | None) -> str:
    """What a model's server said of an error, from the JSON it sent: its message, if it gave one,
    without the key it was asked with.

    The key is taken out of the whole text before it is cut: cut first, a key that straddles the
    cut would leave most of itself behind, out of scrub's reach. Its words are shown and saved
    like the reply, so they leave whole too: a half of a character it sent with no pair becomes
    U+FFFD.
    """
    if isinstance(said, dict):
        said = said.get("error", said)
    host = _host_said(said) if isinstance(said, dict) and said.get("message") else ""
    if isinstance(said, dict):
        said = said.get("message") or said
    words = scrub(str(said), api_key)[:300] if said else ""
    room = 300 - len(words) - len(" ()")
    if host and room > 0:
        # A host can write the key it was passed into its own words, as a gateway does.
        words += f" ({scrub(host, api_key)[:room]})"
    return well_formed(words)


def _host_said(error: dict) -> str:
    """The host a router sent the request to, and what that host said, from the error's
    metadata: the router's own message only says that a host failed, not whether it is down
    or refused the request."""
    metadata = error.get("metadata")
    if not isinstance(metadata, dict):
        return ""
    name = metadata.get("provider_name")
    raw = metadata.get("raw")
    if isinstance(raw, str):
        try:  # a host's JSON, passed on as text
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        raw = parsed if isinstance(parsed, dict) else raw
    if isinstance(raw, dict):
        inner = raw.get("error")
        inner = inner.get("message") if isinstance(inner, dict) else inner
        message = inner if isinstance(inner, str) and inner else raw.get("message")
        raw = message if isinstance(message, str) and message else json.dumps(raw, ensure_ascii=False)
    elif raw is not None and not isinstance(raw, str):
        raw = json.dumps(raw, ensure_ascii=False)
    parts = [part.strip() for part in (name, raw) if isinstance(part, str)]
    return ": ".join(part for part in parts if part)


def scrub(message: str, api_key: str | None) -> str:
    """The message with the key it was asked with cut down to its end, as the page shows it.

    A gateway can write the key it was sent into its error, and every error leaves: to the page,
    and, for a 5xx or a list that failed, into evermind.log."""
    if not api_key or api_key not in message:
        return message
    return message.replace(api_key, f"…{api_key[-4:]}")


def _refusal(status: int, body: bytes, api_key: str | None = None) -> ProviderError:
    try:
        words = words_of(json.loads(body), api_key)
    except (ValueError, RecursionError):
        # Not JSON, or nested deeper than the parser follows: the status alone.
        words = ""
    kind = {401: AUTH_REFUSED, 402: MODEL_NO_CREDIT, 404: MODEL_NOT_FOUND,
            429: RATE_LIMITED}.get(status, MODEL_ERROR)
    return ProviderError(words or f"HTTP {status}", kind, status)


def lost(exc: Exception, base_url: str) -> ProviderError:
    """A request that never reached the server at ``base_url``, or that broke off on the way."""
    if isinstance(exc, httpx.ConnectError | httpx.ConnectTimeout
                  | httpx.UnsupportedProtocol | httpx.InvalidURL):
        return ProviderError(base_url, UNREACHABLE)
    message = str(exc) or (
        "The model took too long to answer, or the connection to its server broke.")
    return ProviderError(message, CONNECTION_LOST)


class Provider:
    """Built from a connection's settings for each use of it."""

    def __init__(self, connection: dict):
        self.connection = connection
        self.base_url = (connection.get("base_url") or "").rstrip("/")
        self.api_key = connection.get("api_key") or ""
        self.model = connection.get("model") or ""
        self._client_factory = lambda: httpx.AsyncClient(timeout=DEFAULT_TIMEOUT)
        # What the server said of the last request, as it came: started afresh by each one.
        self.figures = CallFigures()

    def _headers(self) -> dict:
        raise NotImplementedError

    @classmethod
    def max_tokens_sent(cls, connection: dict) -> int | None:
        """The max_tokens a request on this connection carries: None when it carries none and the
        server's own limit applies."""
        return connection.get("max_tokens") or None

    async def stream_chat(self, payload: PromptPayload) -> AsyncIterator[ProviderEvent]:
        """The reply as it arrives, then its end. A failure raises a ProviderError.

        Every piece of model text leaves here, whole: the reply and the reasoning are each
        joined on their own, so half a reply character never pairs with half a thought.
        """
        reply, reasoning = WholeCharacters(), WholeCharacters()
        async with aclosing(self._events(payload)) as events:
            async for event in events:
                if event.type == "delta":
                    if text := reply.take(event.text):
                        self.figures.chars_out += len(text)
                        yield replace(event, text=text)
                elif event.type == "thought":
                    if text := reasoning.take(event.text):
                        self.figures.thought_chars += len(text)
                        yield ProviderEvent(type="thought", count=len(text))
                else:
                    yield event

    async def _events(self, payload: PromptPayload) -> AsyncIterator[ProviderEvent]:
        """What the server sent, as each event reads: deltas and thoughts with their text."""
        raise NotImplementedError
        yield  # pragma: no cover

    async def list_models(self) -> list[str]:
        # Imported here: the catalog builds on this module.
        from .catalog import read_catalog

        read = await read_catalog(self.connection, probes=False,
                                  client_factory=self._client_factory)
        return [m.id for m in read.models]

    async def _sse(self, path: str, body: dict) -> AsyncIterator[dict]:
        """The objects of the server's event stream, until it says [DONE] or ends."""
        # The figures describe the request that answers: a second try starts them again. Nothing
        # clears them after a stop or an error, which leave what came readable.
        self.figures.reset()
        try:
            async with self._client_factory() as client, client.stream(
                "POST", self.base_url + path, headers=self._headers(), json=body,
            ) as response:
                # Its status line came back: the server has the request, whatever it answers.
                self.figures.sent = True
                if response.status_code >= 400:
                    raise _refusal(response.status_code, await response.aread(), self.api_key)
                async for line in response.aiter_lines():
                    data = line[5:].strip() if line.startswith("data:") else ""
                    if data == "[DONE]":
                        return
                    try:
                        event = json.loads(data)
                    except ValueError:
                        continue
                    if isinstance(event, dict):
                        self.figures.opened = True
                        yield event
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise self._lost(exc)

    def _lost(self, exc: Exception) -> ProviderError:
        return lost(exc, self.base_url)


@dataclass
class Answer:
    """A model's whole answer, and how it ended."""

    text: str
    thought: int  # characters of reasoning that came with it, only counted
    stop: str | None  # what ``ProviderEvent.stop`` says on the "done" event
    figures: CallFigures = field(default_factory=CallFigures)  # the provider's, at the end


# How a model stops when it simply has nothing more to say, whatever its server calls it.
_ORDINARY_ENDS = ("stop", "end_turn", "stop_sequence")
ONLY_THOUGHT = ("The model spent its whole answer thinking and wrote nothing. Raise this AI's "
                "reply ceiling, or use a model that does not think as long.")


def unwritten(answer: Answer, only_thought: str = ONLY_THOUGHT) -> AppError | None:
    """Why an answer has nothing written, when how it ended tells: it reasoned, or ran out of
    room, or its server withheld it and said so. None when it has words, or no clue: each caller
    says that in its own way."""
    if answer.text.strip():
        return None
    if answer.thought or answer.stop == STOPPED_FOR_LENGTH:
        return AppError(only_thought, 502, kind=MODEL_ONLY_THOUGHT)
    if answer.stop and answer.stop not in _ORDINARY_ENDS:
        return AppError(f'The model\'s server withheld the answer ("{answer.stop}").', 502,
                        kind=MODEL_WITHHELD, reason=answer.stop)
    return None


async def complete_answer(provider: Provider, payload: PromptPayload) -> Answer:
    """A model's whole answer, for a caller that has no use for it as it arrives, and that needs
    to tell an answer that never came from one that came empty."""
    parts: list[str] = []
    thought = 0
    stop = None
    async with aclosing(provider.stream_chat(payload)) as stream:
        async for event in stream:
            if event.type == "delta":
                parts.append(event.text)
            elif event.type == "thought":
                thought += event.count
            elif event.type == "done":
                stop = event.stop
    # A stand-in that only streams has no figures to give: the answer then has none.
    figures = getattr(provider, "figures", None) or CallFigures()
    return Answer("".join(parts), thought, stop, figures=figures)


async def complete(provider: Provider, payload: PromptPayload) -> str:
    """A model's whole answer, for a caller that has no use for how it ended."""
    return (await complete_answer(provider, payload)).text
