import aiosqlite

from .base import new_id, now_iso


def to_out(row) -> dict:
    out = dict(row)
    avatar = out.pop("avatar_path", None)
    out["avatar_url"] = f"/api/media/{avatar}" if avatar else None
    out["is_default"] = bool(out["is_default"])
    return out


async def _clear_default(db: aiosqlite.Connection) -> None:
    await db.execute("UPDATE personas SET is_default = 0 WHERE is_default = 1")


async def create(db: aiosqlite.Connection, fields: dict) -> dict:
    persona_id = new_id()
    now = now_iso()
    count = (await (await db.execute("SELECT COUNT(*) AS n FROM personas")).fetchone())["n"]
    is_default = bool(fields.get("is_default")) or count == 0
    if is_default:
        await _clear_default(db)
    await db.execute(
        "INSERT INTO personas (id, name, description, avatar_path, is_default, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (persona_id, fields["name"], fields.get("description") or "",
         fields.get("avatar_path"), int(is_default), now, now),
    )
    await db.commit()
    return await get(db, persona_id)


async def get(db: aiosqlite.Connection, persona_id: str) -> dict | None:
    row = await (await db.execute("SELECT * FROM personas WHERE id = ?", (persona_id,))).fetchone()
    return to_out(row) if row else None


async def list_all(db: aiosqlite.Connection) -> list[dict]:
    rows = await (await db.execute(
        "SELECT * FROM personas ORDER BY is_default DESC, created_at ASC")).fetchall()
    return [to_out(r) for r in rows]


async def get_default(db: aiosqlite.Connection) -> dict | None:
    row = await (await db.execute(
        "SELECT * FROM personas ORDER BY is_default DESC, created_at ASC LIMIT 1")).fetchone()
    return to_out(row) if row else None


async def update(db: aiosqlite.Connection, persona_id: str, fields: dict) -> dict | None:
    if not await get(db, persona_id):
        return None
    if fields.get("is_default"):
        await _clear_default(db)
    sets, params = [], []
    for key in ("name", "description", "avatar_path"):
        if fields.get(key) is not None:
            sets.append(f"{key} = ?")
            params.append(fields[key])
    if fields.get("is_default") is not None:
        sets.append("is_default = ?")
        params.append(int(fields["is_default"]))
    sets.append("updated_at = ?")
    params.append(now_iso())
    params.append(persona_id)
    await db.execute(f"UPDATE personas SET {', '.join(sets)} WHERE id = ?", params)
    await db.commit()
    return await get(db, persona_id)


async def delete(db: aiosqlite.Connection, persona_id: str) -> bool:
    cursor = await db.execute("DELETE FROM personas WHERE id = ?", (persona_id,))
    await db.commit()
    return cursor.rowcount > 0
