import aiosqlite

from .base import new_id, now_iso

_FIELDS = ("name", "provider", "base_url", "model", "context_size",
           "max_tokens", "temperature", "top_p", "frequency_penalty", "presence_penalty")
# The marked connection, else the oldest: the one used when a conversation names none.
_DEFAULT_FIRST = "is_default DESC, created_at, rowid"


def to_out(row) -> dict:
    """Public shape — the API key never leaves the backend."""
    out = dict(row)
    key = out.pop("api_key", "") or ""
    out["api_key_set"] = bool(key)
    out["api_key_hint"] = f"…{key[-4:]}" if key else ""
    out["is_default"] = bool(out["is_default"])
    return out


async def _clear_default(db: aiosqlite.Connection) -> None:
    await db.execute("UPDATE connections SET is_default = 0 WHERE is_default = 1")


async def create(db: aiosqlite.Connection, fields: dict) -> dict:
    conn_id = new_id()
    now = now_iso()
    count = (await (await db.execute("SELECT COUNT(*) AS n FROM connections")).fetchone())["n"]
    is_default = bool(fields.get("is_default")) or count == 0
    if is_default:
        await _clear_default(db)
    await db.execute(
        f"""INSERT INTO connections (id, {", ".join(_FIELDS)}, api_key, is_default,
            created_at, updated_at)
            VALUES (?, {", ".join("?" for _ in _FIELDS)}, ?, ?, ?, ?)""",
        (conn_id, *[fields.get(f) for f in _FIELDS], fields.get("api_key") or "",
         int(is_default), now, now),
    )
    await db.commit()
    return await get(db, conn_id)


async def get(db: aiosqlite.Connection, conn_id: str) -> dict | None:
    row = await (await db.execute("SELECT * FROM connections WHERE id = ?", (conn_id,))).fetchone()
    return to_out(row) if row else None


async def get_raw(db: aiosqlite.Connection, conn_id: str) -> dict | None:
    row = await (await db.execute("SELECT * FROM connections WHERE id = ?", (conn_id,))).fetchone()
    return dict(row) if row else None


async def resolve(db: aiosqlite.Connection, wanted: str | None) -> dict | None:
    """The connection asked for while it exists, else the default one, key included."""
    row = await (await db.execute(
        f"SELECT * FROM connections ORDER BY id IS ? DESC, {_DEFAULT_FIRST} LIMIT 1",
        (wanted,))).fetchone()
    return dict(row) if row else None


async def list_all(db: aiosqlite.Connection) -> list[dict]:
    rows = await (await db.execute(
        f"SELECT * FROM connections ORDER BY {_DEFAULT_FIRST}")).fetchall()
    out = [to_out(r) for r in rows]
    if out:
        out[0]["is_default"] = True  # with none marked, the oldest is the one used
    return out


async def update(db: aiosqlite.Connection, conn_id: str, fields: dict) -> dict | None:
    if not await get(db, conn_id):
        return None
    if fields["is_default"]:
        await _clear_default(db)
    await db.execute(
        f"UPDATE connections SET {', '.join(f'{f} = ?' for f in _FIELDS)},"
        " api_key = COALESCE(?, api_key), is_default = ?, updated_at = ? WHERE id = ?",
        (*[fields[f] for f in _FIELDS], fields["api_key"], int(fields["is_default"]), now_iso(),
         conn_id),
    )
    await db.commit()
    return await get(db, conn_id)


async def delete(db: aiosqlite.Connection, conn_id: str) -> bool:
    cursor = await db.execute("DELETE FROM connections WHERE id = ?", (conn_id,))
    await db.commit()
    return cursor.rowcount > 0
