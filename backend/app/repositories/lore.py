import aiosqlite

from .base import dumps, loads, new_id, now_iso


def to_out(row) -> dict:
    out = dict(row)
    out["keys"] = loads(out.get("keys"), [])
    out["enabled"] = bool(out["enabled"])
    out["case_sensitive"] = bool(out["case_sensitive"])
    return out


async def list_for_character(db: aiosqlite.Connection, char_id: str) -> list[dict]:
    rows = await (await db.execute(
        "SELECT * FROM lore_entries WHERE character_id = ?"
        " ORDER BY priority DESC, created_at ASC", (char_id,))).fetchall()
    return [to_out(r) for r in rows]


async def add(db: aiosqlite.Connection, char_id: str, keys: list[str], content: str,
              enabled: bool = True, case_sensitive: bool = False,
              priority: int = 0) -> dict | None:
    content = (content or "").strip()
    keys = [str(k).strip() for k in keys or [] if str(k).strip()]
    if not content or not keys:
        return None
    entry_id = new_id()
    now = now_iso()
    await db.execute(
        "INSERT INTO lore_entries (id, character_id, keys, content, enabled,"
        " case_sensitive, priority, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (entry_id, char_id, dumps(keys), content, int(enabled),
         int(case_sensitive), priority, now, now),
    )
    await db.commit()
    return await get(db, entry_id)


async def get(db: aiosqlite.Connection, entry_id: str) -> dict | None:
    row = await (await db.execute(
        "SELECT * FROM lore_entries WHERE id = ?", (entry_id,))).fetchone()
    return to_out(row) if row else None


async def update(db: aiosqlite.Connection, entry_id: str, fields: dict) -> dict | None:
    if not await get(db, entry_id):
        return None
    sets, params = [], []
    if fields.get("keys") is not None:
        sets.append("keys = ?")
        params.append(dumps([str(k).strip() for k in fields["keys"] if str(k).strip()]))
    if fields.get("content") is not None:
        sets.append("content = ?")
        params.append(fields["content"].strip())
    for key in ("enabled", "case_sensitive"):
        if fields.get(key) is not None:
            sets.append(f"{key} = ?")
            params.append(int(fields[key]))
    if fields.get("priority") is not None:
        sets.append("priority = ?")
        params.append(int(fields["priority"]))
    sets.append("updated_at = ?")
    params.append(now_iso())
    params.append(entry_id)
    await db.execute(f"UPDATE lore_entries SET {', '.join(sets)} WHERE id = ?", params)
    await db.commit()
    return await get(db, entry_id)


async def delete(db: aiosqlite.Connection, entry_id: str) -> bool:
    cursor = await db.execute("DELETE FROM lore_entries WHERE id = ?", (entry_id,))
    await db.commit()
    return cursor.rowcount > 0
