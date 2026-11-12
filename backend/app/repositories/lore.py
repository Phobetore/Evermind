import aiosqlite

from ..models.schemas import LoreEntryIn
from .base import dumps, loads, new_id, now_iso

# What an entry carries besides its keywords, text and switch, with the defaults a request gets:
# a caller that gives none of them keeps the entry as it behaved before they existed.
_SETTINGS = {
    name: LoreEntryIn.model_fields[name].default
    for name in ("origin", "comment", "constant", "selective", "secondary_keys", "selective_logic",
                 "insertion_order", "position", "depth", "role", "whole_words",
                 "exclude_recursion", "prevent_recursion")
}
_SWITCHES = ("enabled", "constant", "selective", "whole_words", "exclude_recursion",
             "prevent_recursion")


def to_out(row) -> dict:
    out = dict(row)
    out["keys"] = loads(out.get("keys"), [])
    out["secondary_keys"] = loads(out.get("secondary_keys"), [])
    for name in _SWITCHES:
        out[name] = bool(out[name])
    return out


async def list_for_character(db: aiosqlite.Connection, char_id: str) -> list[dict]:
    # Written in one go, a lorebook's entries share their second: the rowid keeps their order.
    rows = await (await db.execute(
        "SELECT * FROM lore_entries WHERE character_id = ? ORDER BY created_at, rowid",
        (char_id,))).fetchall()
    return [to_out(r) for r in rows]


def clean_keys(keys: list[str] | None) -> list[str]:
    return [str(k).strip() for k in keys or [] if str(k).strip()]


def storable(keys: list[str], content: str, constant: bool) -> bool:
    """An entry with text, and a keyword or always on. Emptying the text is how an entry is taken out."""
    return bool(content.strip()) and (bool(keys) or constant)


def clean(entries: list[dict]) -> list[dict]:
    """The entries as they are stored, in order, less those that are not kept. The reading kept
    with a card goes through here too, so that it says which entries of the card were taken."""
    kept = []
    for entry in entries:
        # A partial update, or a caller from before the settings, leaves out what is unset.
        settings = {name: entry.get(name, default) for name, default in _SETTINGS.items()}
        settings["secondary_keys"] = clean_keys(settings["secondary_keys"])
        cleaned = {"keys": clean_keys(entry["keys"]), "content": entry["content"].strip(),
                   "enabled": bool(entry.get("enabled", True)), **settings}
        for name in _SWITCHES:
            cleaned[name] = bool(cleaned[name])
        if storable(cleaned["keys"], cleaned["content"], cleaned["constant"]):
            kept.append(cleaned)
    return kept


async def replace(db: aiosqlite.Connection, char_id: str, entries: list[dict]) -> None:
    """The whole lorebook, in order, less the entries `storable` refuses. Does not commit."""
    now = now_iso()
    rows = [
        (new_id(), char_id, dumps(e["keys"]), e["content"], int(e["enabled"]), e["origin"],
         e["comment"], int(e["constant"]), int(e["selective"]), dumps(e["secondary_keys"]),
         e["selective_logic"], e["insertion_order"], e["position"], e["depth"], e["role"],
         int(e["whole_words"]), int(e["exclude_recursion"]), int(e["prevent_recursion"]), now, now)
        for e in clean(entries)
    ]
    await db.execute("DELETE FROM lore_entries WHERE character_id = ?", (char_id,))
    await db.executemany(
        "INSERT INTO lore_entries (id, character_id, keys, content, enabled, origin, comment,"
        " constant, selective, secondary_keys, selective_logic, insertion_order, position, depth,"
        " role, whole_words, exclude_recursion, prevent_recursion, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
