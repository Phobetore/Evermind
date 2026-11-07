"""What surrounds the prompt of one turn: the history of a continuation, the scene
that recall is ranked against, the messages recall may draw on, and the cleanup of
the reply.

Pure: no database, no model.
"""

from collections.abc import Collection

from .engine import active_content

CONTINUE_INSTRUCTION = (
    "[Continue your previous reply exactly where it stopped. Do not repeat anything, "
    "do not start over — just keep going seamlessly.]"
)


def is_out_of_character(message: dict) -> bool:
    return (message.get("meta") or {}).get("mode") == "ooc"


def trim_reply(text: str, char_name: str, user_name: str) -> str:
    """Post-generation cleanup: drop anything the model wrote for the player,
    and a leading "Name:" speaker tag if present."""
    for marker in (f"\n{user_name}:", f"\n{user_name} :"):
        index = text.find(marker)
        if index != -1:
            text = text[:index]
    stripped = text.lstrip()
    for prefix in (f"{char_name}:", f"{char_name} :"):
        if stripped.startswith(prefix):
            text = stripped[len(prefix):].lstrip()
            break
    return text.rstrip()


def continue_history(messages: list[dict]) -> list[dict]:
    """The history of a continuation: the chat, then an instruction from the player
    to carry on, one position after the reply that is being extended."""
    return messages + [{
        "role": "user", "variants": [CONTINUE_INSTRUCTION], "active_index": 0,
        "position": messages[-1]["position"] + 1,
    }]


def scene_of(history: list[dict]) -> str:
    """The live scene, which facts and past messages are ranked against: the last
    couple of turns."""
    return "\n".join(active_content(m) for m in history[-2:]) if history else ""


def passage_candidates(history: list[dict], stats: dict) -> tuple[list[dict], set[int]]:
    """The messages that recall may draw on, and the turns that a fact already covers.
    ``stats`` is that of the payload built first: its ``oldest_visible`` is where the
    window starts, and a message at or after it is still in the prompt."""
    oldest_visible = stats.get("oldest_visible") or 0
    fact_positions = {p for p in (stats.get("fact_positions") or []) if p is not None}
    candidates = [m for m in history
                  if (m.get("position") or 0) < oldest_visible and not is_out_of_character(m)]
    return candidates, fact_positions


def passage_infos(candidates: list[dict], ids: Collection[str]) -> list[dict]:
    """What a candidate is, to the ranking of passages, for those that have a vector."""
    wanted = set(ids)
    return [{"id": m["id"], "content": active_content(m),
             "position": m.get("position") or 0, "role": m["role"]}
            for m in candidates if m["id"] in wanted]
