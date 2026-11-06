"""SQLite access and migrations.

One connection per request via `get_db` dependency; migrations are plain SQL
files in `migrations/`, applied in filename order and recorded in
`schema_migrations`. Each file runs in one transaction with foreign keys off:
it holds no BEGIN or COMMIT, and a DELETE in it cascades to nothing.
"""

from collections.abc import AsyncIterator
from pathlib import Path

import aiosqlite

from .config import db_path

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


async def _connect() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(db_path())
    try:
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA foreign_keys = ON")
        await conn.execute("PRAGMA journal_mode = WAL")
    except BaseException:
        # Cancelled included: nobody else has been handed this connection to close.
        await conn.close()
        raise
    return conn


# For code that runs outside a request handler, such as a middleware, and so
# cannot be given a connection by the `get_db` dependency.
connect = _connect


async def init_db() -> None:
    conn = await _connect()
    try:
        # Rebuilding a table with keys on would cascade to the rows pointing at it.
        await conn.execute("PRAGMA foreign_keys = OFF")
        await conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)"
        )
        applied = {
            row["name"]
            for row in await (await conn.execute("SELECT name FROM schema_migrations")).fetchall()
        }
        pending = [p for p in sorted(MIGRATIONS_DIR.glob("*.sql")) if p.name not in applied]
        if applied and pending:
            # Named after the first new file, so that a retry after a later one fails keeps it.
            backup = db_path().with_name(f"evermind.before-{pending[0].stem}.db")
            backup.unlink(missing_ok=True)
            await conn.execute("VACUUM INTO ?", (str(backup),))
        for path in pending:
            await conn.executescript(
                f"BEGIN;\n{path.read_text(encoding='utf-8')}\n;\n"
                f"INSERT INTO schema_migrations (name) VALUES ('{path.name}');\nCOMMIT;"
            )
    finally:
        await conn.close()


async def get_db() -> AsyncIterator[aiosqlite.Connection]:
    conn = await _connect()
    try:
        yield conn
    finally:
        await conn.close()
