import aiosqlite

from .base import dumps, loads

DEFAULTS = {
    "default_connection_id": None,
    "default_persona_id": None,
    "global_instructions": "",
    "auto_memory": True,
    "reply_length": "medium",
    # Raw turns sent to the model; older ones live in summary + facts. Short
    # windows keep small local models attentive instead of echoing themselves.
    "history_limit": 24,
    # Token budget for verbatim past passages retrieved by relevance. 0 = off.
    "passage_budget": 1500,
    # One GET to GitHub a day, to say whether a newer release exists. On by
    # default so security fixes are not missed by people who never think to
    # look; off is one checkbox away, in About.
    "update_check": True,
}


async def get_all(db: aiosqlite.Connection) -> dict:
    rows = await (await db.execute("SELECT key, value FROM settings")).fetchall()
    stored = {row["key"]: loads(row["value"], None) for row in rows}
    return {**DEFAULTS, **{k: v for k, v in stored.items() if k in DEFAULTS}}


async def forget(db: aiosqlite.Connection, key: str, value: str) -> None:
    """Drop a stored reference once the row it points at is deleted, so it can
    never be handed out as a dangling foreign key."""
    if key not in DEFAULTS or not value:
        return
    row = await (await db.execute("SELECT value FROM settings WHERE key = ?", (key,))).fetchone()
    if row and loads(row["value"], None) == value:
        await db.execute("DELETE FROM settings WHERE key = ?", (key,))
        await db.commit()


async def put(db: aiosqlite.Connection, values: dict) -> dict:
    for key, value in values.items():
        if key not in DEFAULTS or value is None:
            continue
        await db.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, dumps(value)),
        )
    await db.commit()
    return await get_all(db)
