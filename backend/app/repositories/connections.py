import aiosqlite

from .base import dumps, loads, new_id, now_iso

_FIELDS = ("name", "provider", "base_url", "model", "context_size", "max_tokens",
           "temperature", "top_p", "frequency_penalty", "presence_penalty")


def to_out(row) -> dict:
    """Public shape — the API key never leaves the backend."""
    out = dict(row)
    key = out.pop("api_key", "") or ""
    out["api_key_set"] = bool(key)
    out["api_key_hint"] = f"…{key[-4:]}" if key else ""
    out["extra_params"] = loads(out.get("extra_params"), {})
    out["is_default"] = bool(out["is_default"])
    return out


def to_raw(row) -> dict:
    """Internal shape (key included) for providers."""
    out = dict(row)
    out["extra_params"] = loads(out.get("extra_params"), {})
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
        f"""INSERT INTO connections (id, {", ".join(_FIELDS)}, api_key, extra_params, is_default,
            created_at, updated_at)
            VALUES (?, {", ".join("?" for _ in _FIELDS)}, ?, ?, ?, ?, ?)""",
        (conn_id, *[fields.get(f) for f in _FIELDS], fields.get("api_key") or "",
         dumps(fields.get("extra_params") or {}), int(is_default), now, now),
    )
    await db.commit()
    return await get(db, conn_id)


async def get(db: aiosqlite.Connection, conn_id: str) -> dict | None:
    row = await (await db.execute("SELECT * FROM connections WHERE id = ?", (conn_id,))).fetchone()
    return to_out(row) if row else None


async def get_raw(db: aiosqlite.Connection, conn_id: str) -> dict | None:
    row = await (await db.execute("SELECT * FROM connections WHERE id = ?", (conn_id,))).fetchone()
    return to_raw(row) if row else None


async def get_default_raw(db: aiosqlite.Connection) -> dict | None:
    row = await (await db.execute(
        "SELECT * FROM connections ORDER BY is_default DESC, created_at ASC LIMIT 1")).fetchone()
    return to_raw(row) if row else None


async def list_all(db: aiosqlite.Connection) -> list[dict]:
    rows = await (await db.execute(
        "SELECT * FROM connections ORDER BY is_default DESC, created_at ASC")).fetchall()
    return [to_out(r) for r in rows]


async def update(db: aiosqlite.Connection, conn_id: str, fields: dict) -> dict | None:
    if not await get(db, conn_id):
        return None
    if fields.get("is_default"):
        await _clear_default(db)
    sets, params = [], []
    for key in _FIELDS:
        if fields.get(key) is not None:
            sets.append(f"{key} = ?")
            params.append(fields[key])
    if fields.get("api_key") is not None:  # None keeps the key, "" clears it
        sets.append("api_key = ?")
        params.append(fields["api_key"])
    if fields.get("extra_params") is not None:
        sets.append("extra_params = ?")
        params.append(dumps(fields["extra_params"]))
    if fields.get("is_default") is not None:
        sets.append("is_default = ?")
        params.append(int(fields["is_default"]))
    sets.append("updated_at = ?")
    params.append(now_iso())
    params.append(conn_id)
    await db.execute(f"UPDATE connections SET {', '.join(sets)} WHERE id = ?", params)
    await db.commit()
    return await get(db, conn_id)


async def delete(db: aiosqlite.Connection, conn_id: str) -> bool:
    cursor = await db.execute("DELETE FROM connections WHERE id = ?", (conn_id,))
    await db.commit()
    return cursor.rowcount > 0
