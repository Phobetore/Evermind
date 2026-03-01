"""SQLite database initialisation, connection helpers, and migration runner."""

from __future__ import annotations

import logging
import os
from pathlib import Path

import aiosqlite

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parents[3]

DATABASE_PATH = os.getenv("DATABASE_PATH", str(_PROJECT_ROOT / "data" / "app.db"))

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / ".." / "migrations"


async def get_db(db_path: str | None = None) -> aiosqlite.Connection:
    """Open a new database connection with recommended pragmas."""
    path = db_path or DATABASE_PATH
    db = await aiosqlite.connect(path)
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA synchronous=NORMAL")
    await db.execute("PRAGMA foreign_keys=ON")
    db.row_factory = aiosqlite.Row
    return db


async def run_migrations(db: aiosqlite.Connection, migrations_dir: Path | None = None) -> None:
    """Apply all pending SQL migration files in order."""
    mdir = migrations_dir or MIGRATIONS_DIR.resolve()
    # Ensure the tracking table exists
    await db.execute(
        """
        CREATE TABLE IF NOT EXISTS _migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    await db.commit()

    # Fetch already-applied migrations
    cursor = await db.execute("SELECT name FROM _migrations ORDER BY id")
    applied = {row[0] for row in await cursor.fetchall()}

    # Discover and sort migration files
    if not mdir.is_dir():
        logger.warning("Migrations directory not found: %s", mdir)
        return

    migration_files = sorted(mdir.glob("*.sql"))
    for mf in migration_files:
        if mf.name in applied:
            continue
        logger.info("Applying migration: %s", mf.name)
        sql = mf.read_text(encoding="utf-8")
        await db.executescript(sql)
        await db.execute("INSERT INTO _migrations (name) VALUES (?)", (mf.name,))
        await db.commit()
        logger.info("Migration applied: %s", mf.name)


async def init_db(db_path: str | None = None) -> None:
    """Create the data directory and apply all pending migrations."""
    path = db_path or DATABASE_PATH
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    db = await get_db(path)
    try:
        await run_migrations(db)
    finally:
        await db.close()
