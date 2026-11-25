import aiosqlite

from .base import dumps, loads

DEFAULTS = {
    "global_instructions": "",
    "auto_memory": True,
    # The ways of playing a person changed or made (prompting/ways.py), written by
    # repositories/ways.py alone: the edits of a built-in way, and the ways of their own.
    "play_styles": {"overrides": {}, "custom": []},
    # The way a new conversation plays.
    "default_play_style": "balanced",
    # Whether Settings asks GitHub for a newer release each time it opens: on, so that nobody
    # misses a security fix; off in About.
    "update_check": True,
}


async def get_all(db: aiosqlite.Connection) -> dict:
    rows = await (await db.execute("SELECT key, value FROM settings")).fetchall()
    stored = {row["key"]: loads(row["value"], None) for row in rows}
    return {**DEFAULTS, **{k: v for k, v in stored.items() if k in DEFAULTS}}


async def store(db: aiosqlite.Connection, key: str, value) -> None:
    """One setting written, uncommitted: inside the caller's transaction."""
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, dumps(value)),
    )


async def put(db: aiosqlite.Connection, values: dict) -> dict:
    """Store the given settings. A `None` says nothing and is ignored."""
    for key, value in values.items():
        if key not in DEFAULTS or value is None:
            continue
        await store(db, key, value)
    await db.commit()
    return await get_all(db)
