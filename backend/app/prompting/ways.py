"""The ways of playing: how much of the story a conversation rereads, how long its replies run,
and how much room the reminders (facts, lorebook, past passages) take. Pure, and the same in
the TypeScript engine (frontend/src/engine/ways.ts).

The four built in are constants; only what a person changed is stored (settings.play_styles:
the edits of a built-in way under "overrides", the ways they made under "custom"). "balanced"
is the engine as it was before ways existed, figure for figure.
"""

from typing import Literal

Length = Literal["short", "medium", "long"]
Level = Literal["essential", "normal", "rich", "all"]

FIELDS = ("history_limit", "reply_length", "reply_room", "facts_cap", "max_facts",
          "lore_cap", "lore_share", "passage_cap", "passage_share")
REMINDER_FIELDS = ("facts_cap", "max_facts", "lore_cap", "lore_share", "passage_cap", "passage_share")
REPLY_ROOM = {"short": 512, "medium": 1024, "long": 2048}

LEVELS: dict[Level, dict] = {
    "essential": {"facts_cap": 700, "max_facts": 60, "lore_cap": 400, "lore_share": 0.06,
                  "passage_cap": 0, "passage_share": None},
    # What the engine always gave: 2000 tokens of facts at most, 60 facts, 800 of lorebook,
    # 1500 of past passages.
    "normal": {"facts_cap": 2000, "max_facts": 60, "lore_cap": 800, "lore_share": None,
               "passage_cap": 1500, "passage_share": None},
    "rich": {"facts_cap": 4000, "max_facts": 120, "lore_cap": 1600, "lore_share": 0.06,
             "passage_cap": 3000, "passage_share": 0.10},
    "all": {"facts_cap": None, "max_facts": None, "lore_cap": None, "lore_share": 0.06,
            "passage_cap": None, "passage_share": 0.10},
}
BUILT_IN: dict[str, dict] = {
    "light": {"history_limit": 16, "reply_length": "short", "reply_room": 512, **LEVELS["essential"]},
    "balanced": {"history_limit": 24, "reply_length": "medium", "reply_room": 1024, **LEVELS["normal"]},
    "immersive": {"history_limit": 60, "reply_length": "long", "reply_room": 2048, **LEVELS["rich"]},
    # Immersive that rereads the whole story (0: no limit).
    "maximum": {"history_limit": 0, "reply_length": "long", "reply_room": 2048, **LEVELS["rich"]},
}
FACTS_FLOOR = 700
FACTS_SHARE = 0.12

# No way given: the engine's figures from before ways existed.
_FACTS_CAP_BEFORE = 2000
_MAX_FACTS_BEFORE = 60
_LORE_BEFORE = 800
_PASSAGES_BEFORE = 1500


def _found(play_styles: dict, way_id: str | None) -> dict | None:
    if way_id is None:
        return None
    if way_id in BUILT_IN:
        original = BUILT_IN[way_id]
        stored = (play_styles.get("overrides") or {}).get(way_id) or {}
        edits = {k: stored[k] for k in FIELDS if k in stored}
        return {"id": way_id, "name": None, "built_in": True,
                "overridden": any(original[k] != v for k, v in edits.items()),
                **original, **edits}
    for custom in play_styles.get("custom") or []:
        if custom.get("id") == way_id:
            # A field missing from what was stored plays as balanced, never as nothing.
            fields = {**BUILT_IN["balanced"], **{k: custom[k] for k in FIELDS if k in custom}}
            return {"id": way_id, "name": custom.get("name"), "built_in": False,
                    "overridden": False, **fields}
    return None


def way_of(play_styles: dict | None, way_id: str | None, default_id: str | None) -> dict:
    """{"id", "name", "built_in", "overridden", **the nine FIELDS}: a built-in with its stored
    overrides merged (only the fields stored), else a custom way; an unknown id resolves to
    default_id, then to "balanced". name is None for a built-in and for "mine"."""
    styles = play_styles or {}
    return (_found(styles, way_id) or _found(styles, default_id)
            or _found(styles, "balanced"))


def level_of(fields: dict) -> Level | None:
    """The level whose six fields all equal these, else None."""
    for level, values in LEVELS.items():
        if all(fields.get(k) == v for k, v in values.items()):
            return level
    return None


def applied(way: dict, overrides: dict | None) -> dict:
    """The way with a conversation's overrides: history_limit as is; reply_length with its room
    (REPLY_ROOM); reminders replaces the six REMINDER_FIELDS by LEVELS[level]. Adds "adjusted":
    True when at least one override differs from the way's own value. An override equal to the
    way's value, or one that cannot be read, changes nothing."""
    result = dict(way)
    adjusted = False
    given = overrides or {}
    limit = given.get("history_limit")
    if isinstance(limit, int) and not isinstance(limit, bool) and limit != way["history_limit"]:
        result["history_limit"] = limit
        adjusted = True
    length = given.get("reply_length")
    if length in REPLY_ROOM and length != way["reply_length"]:
        result["reply_length"] = length
        result["reply_room"] = REPLY_ROOM[length]
        adjusted = True
    level = given.get("reminders")
    if level in LEVELS and level != level_of(way):
        result.update(LEVELS[level])
        adjusted = True
    result["adjusted"] = adjusted
    return result


def way_for(conversation: dict | None, settings: dict) -> dict:
    """The way a conversation plays, its own overrides applied; None: the way offered to new
    conversations, unadjusted."""
    way = way_of(settings.get("play_styles"), (conversation or {}).get("play_style"),
                 settings.get("default_play_style"))
    return applied(way, (conversation or {}).get("play_overrides"))


def _smaller(cap: int | None, share: float | None, budget: int) -> int:
    """The smaller of a cap and a share of the budget, for those given; neither: the budget."""
    bounds = [b for b in (cap, None if share is None else int(budget * share)) if b is not None]
    return min(bounds) if bounds else budget


def facts_budget(reminders: dict | None, budget: int) -> int:
    if reminders is None:
        return min(_FACTS_CAP_BEFORE, max(FACTS_FLOOR, int(budget * FACTS_SHARE)))
    room = max(FACTS_FLOOR, int(budget * FACTS_SHARE))
    cap = reminders["facts_cap"]
    return room if cap is None else min(room, cap)


def max_facts(reminders: dict | None) -> int | None:
    """How many facts at most; None: as many as fit."""
    return _MAX_FACTS_BEFORE if reminders is None else reminders["max_facts"]


def lore_budget(reminders: dict | None, budget: int) -> int:
    """The lorebook of a card on Evermind's own rules. A community card's keeps its quarter of
    the budget whatever the way (engine.py)."""
    if reminders is None:
        return _LORE_BEFORE
    return _smaller(reminders["lore_cap"], reminders["lore_share"], budget)


def passage_budget(reminders: dict | None, budget: int) -> int:
    if reminders is None:
        return _PASSAGES_BEFORE
    return _smaller(reminders["passage_cap"], reminders["passage_share"], budget)


def outlook_entry(stats: dict, *, ratio: float, history_limit: int, reply_room: int,
                  cap_short: int | None) -> dict:
    """What a prompt built ahead of a turn says, in the server's tokens: the engine counts in
    estimated ones, which the measured ratio turns into the server's."""
    parts = stats["parts"]
    return {
        "used_tokens": round(stats["used_tokens"] * ratio),
        "budget": round(stats["budget"] * ratio),
        "context_size": stats["context_size"],
        "messages_included": stats["messages_included"],
        "messages_total": stats["messages_total"],
        "history_limit": history_limit,
        "reply_room": reply_room,
        "parts": {k: round(parts[k] * ratio) for k in ("card", "reminders", "history")},
        "cap_short": cap_short,
    }


def stand_in_passages(tokens: int) -> list[dict]:
    """One passage that costs the given budget, so that an outlook counts the past passages a
    turn may add without searching for them. The shortest text of that cost."""
    if tokens <= 0:
        return []
    # estimate_tokens(n characters) is int(n / 3.5) + 1: the least n giving t is 3.5 (t - 1)
    # rounded up, and 1 for t = 1 (an empty text costs nothing).
    length = max(1, (7 * (tokens - 1) + 1) // 2)
    return [{"role": "user", "position": 0, "content": "x" * length}]
