import aiosqlite

from .base import dumps, loads

DEFAULTS = {
    "global_instructions": "",
    "auto_memory": True,
    "reply_length": "medium",
    # Raw turns sent to the model; older ones live in summary + facts. Short
    # windows keep small local models attentive instead of echoing themselves.
    "history_limit": 24,
    # Token budget for verbatim past passages retrieved by relevance. 0 = off.
    "passage_budget": 1500,
    # Whether Settings asks GitHub for a newer release each time it opens: on, so that nobody
    # misses a security fix; off in About.
    "update_check": True,
}


async def get_all(db: aiosqlite.Connection) -> dict:
    rows = await (await db.execute("SELECT key, value FROM settings")).fetchall()
    stored = {row["key"]: loads(row["value"], None) for row in rows}
    return {**DEFAULTS, **{k: v for k, v in stored.items() if k in DEFAULTS}}


async def put(db: aiosqlite.Connection, values: dict) -> dict:
    """Store the given settings. A `None` says nothing and is ignored."""
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
