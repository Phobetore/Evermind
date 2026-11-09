import aiosqlite

from .base import dumps, loads, new_id, now_iso


def to_out(row) -> dict:
    out = dict(row)
    out["keys"] = loads(out.get("keys"), [])
    out["enabled"] = bool(out["enabled"])
    return out


async def list_for_character(db: aiosqlite.Connection, char_id: str) -> list[dict]:
    # Written in one go, a lorebook's entries share their second: the rowid keeps their order.
    rows = await (await db.execute(
        "SELECT * FROM lore_entries WHERE character_id = ? ORDER BY created_at, rowid",
        (char_id,))).fetchall()
    return [to_out(r) for r in rows]


def clean_keys(keys: list[str] | None) -> list[str]:
    return [str(k).strip() for k in keys or [] if str(k).strip()]


async def replace(db: aiosqlite.Connection, char_id: str, entries: list[dict]) -> None:
    """The whole lorebook, in order, less entries with no keyword or no text. Does not commit."""
    now = now_iso()
    rows = []
    for entry in entries:
        keys, content = clean_keys(entry["keys"]), entry["content"].strip()
        if keys and content:
            enabled = int(entry.get("enabled", True))  # a partial update leaves out what is unset
            rows.append((new_id(), char_id, dumps(keys), content, enabled, now, now))
    await db.execute("DELETE FROM lore_entries WHERE character_id = ?", (char_id,))
    await db.executemany(
        "INSERT INTO lore_entries (id, character_id, keys, content, enabled, created_at,"
        " updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
