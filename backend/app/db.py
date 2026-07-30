"""SQLite access and migrations.

One connection per request via `get_db` dependency; migrations are plain SQL
files in `migrations/`, applied in filename order and recorded in
`schema_migrations`.
"""

from collections.abc import AsyncIterator
from pathlib import Path

import aiosqlite

from .config import db_path

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


async def _connect() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(db_path())
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    await conn.execute("PRAGMA journal_mode = WAL")
    return conn


async def init_db() -> None:
    conn = await _connect()
    try:
        await conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)"
        )
        applied = {
            row["name"]
            for row in await (await conn.execute("SELECT name FROM schema_migrations")).fetchall()
        }
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in applied:
                continue
            await conn.executescript(path.read_text(encoding="utf-8"))
            await conn.execute("INSERT INTO schema_migrations (name) VALUES (?)", (path.name,))
        await conn.commit()
    finally:
        await conn.close()


async def get_db() -> AsyncIterator[aiosqlite.Connection]:
    conn = await _connect()
    try:
        yield conn
    finally:
        await conn.close()
