import aiosqlite

from .base import dumps, loads, new_id, now_iso

_JSON_FIELDS = ("alternate_greetings", "tags")
_TEXT_FIELDS = (
    "kind", "name", "tagline", "description", "personality", "scenario", "greeting",
    "example_dialogues", "system_prompt", "post_history_instructions", "creator_notes",
    "creator", "character_version",
)


def to_out(row) -> dict:
    out = dict(row)
    for f in _JSON_FIELDS:
        out[f] = loads(out.get(f), [])
    avatar = out.pop("avatar_path", None)
    out["avatar_url"] = f"/api/media/{avatar}" if avatar else None
    out["is_favorite"] = bool(out.get("is_favorite"))
    return out


async def create(db: aiosqlite.Connection, fields: dict) -> dict:
    char_id = new_id()
    now = now_iso()
    values = {f: fields.get(f) or "" for f in _TEXT_FIELDS}
    values["kind"] = values["kind"] or "character"
    await db.execute(
        f"""INSERT INTO characters (id, {", ".join(_TEXT_FIELDS)}, alternate_greetings, tags,
            avatar_path, created_at, updated_at)
            VALUES (?, {", ".join("?" for _ in _TEXT_FIELDS)}, ?, ?, ?, ?, ?)""",
        (char_id, *[values[f] for f in _TEXT_FIELDS],
         dumps([str(g) for g in fields.get("alternate_greetings") or []]),
         dumps([str(t) for t in fields.get("tags") or []]),
         fields.get("avatar_path"), now, now),
    )
    await db.commit()
    return await get(db, char_id)


async def get(db: aiosqlite.Connection, char_id: str) -> dict | None:
    row = await (await db.execute("SELECT * FROM characters WHERE id = ?", (char_id,))).fetchone()
    return to_out(row) if row else None


async def get_raw(db: aiosqlite.Connection, char_id: str) -> dict | None:
    """Internal shape (avatar_path kept, JSON parsed) for prompt/export code."""
    row = await (await db.execute("SELECT * FROM characters WHERE id = ?", (char_id,))).fetchone()
    if not row:
        return None
    out = dict(row)
    for f in _JSON_FIELDS:
        out[f] = loads(out.get(f), [])
    return out


async def list_all(db: aiosqlite.Connection, kind: str | None = None,
                   q: str | None = None, tag: str | None = None,
                   favorites: bool = False) -> list[dict]:
    sql = "SELECT * FROM characters"
    clauses, params = [], []
    if kind in ("character", "scenario"):
        clauses.append("kind = ?")
        params.append(kind)
    if q:
        clauses.append("(name LIKE ? OR tagline LIKE ? OR description LIKE ?)")
        like = f"%{q}%"
        params += [like, like, like]
    if favorites:
        clauses.append("is_favorite = 1")
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY is_favorite DESC, updated_at DESC"
    rows = await (await db.execute(sql, params)).fetchall()
    out = [to_out(r) for r in rows]
    if tag:
        needle = tag.lower()
        out = [c for c in out if needle in [t.lower() for t in c["tags"]]]
    return out


async def update(db: aiosqlite.Connection, char_id: str, fields: dict) -> dict | None:
    current = await get_raw(db, char_id)
    if not current:
        return None
    sets, params = [], []
    for key, value in fields.items():
        if value is None:
            continue
        if key in _JSON_FIELDS:
            sets.append(f"{key} = ?")
            params.append(dumps([str(x) for x in value]))
        elif key in _TEXT_FIELDS or key == "avatar_path":
            sets.append(f"{key} = ?")
            params.append(value)
        elif key == "is_favorite":
            sets.append("is_favorite = ?")
            params.append(int(bool(value)))
    sets.append("updated_at = ?")
    params.append(now_iso())
    params.append(char_id)
    await db.execute(f"UPDATE characters SET {', '.join(sets)} WHERE id = ?", params)
    await db.commit()
    return await get(db, char_id)


async def delete(db: aiosqlite.Connection, char_id: str) -> bool:
    cursor = await db.execute("DELETE FROM characters WHERE id = ?", (char_id,))
    await db.commit()
    return cursor.rowcount > 0
