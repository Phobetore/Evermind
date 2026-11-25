"""Writes a database as the release before AIs left it, with one connection on it.

    python scripts/make_legacy_db.py <folder> --mock-port <port>

The API never makes an AI brought over from a connection: only the real update does. The browser
suite starts on this database, so that its server runs that update on start, as it does for anyone
who updates, and every test then runs on a database that was migrated.

Only the standard library: it runs before any server, with whichever Python starts the suite.
"""

import argparse
import sqlite3
import uuid
from datetime import UTC, datetime
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent.parent / "backend" / "migrations"
# The update that split connections into services and their AIs: everything before it is applied.
UPDATE = "021_my_ais.sql"


def write(folder: Path, mock_port: int) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "evermind.db"
    if path.exists():
        raise SystemExit(f"{path} already exists: this writes a new database, never over one.")
    before = [p for p in sorted(MIGRATIONS.glob("*.sql")) if p.name < UPDATE]
    conn = sqlite3.connect(path)
    try:
        # As the server's runner does (app/db.py): keys off, every file in one transaction, each
        # recorded under its whole name, so that the server applies the update alone.
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)")
        script = "".join(
            f"{p.read_text(encoding='utf-8')}\n;\n"
            f"INSERT INTO schema_migrations (name) VALUES ('{p.name}');\n"
            for p in before)
        conn.executescript(f"BEGIN;\n{script}COMMIT;")
        at = datetime.now(UTC).isoformat(timespec="seconds")
        # An LM Studio at an address the update does not know: it makes a generic service, whose
        # first read learns the family from the probes. Not the default.
        conn.execute(
            "INSERT INTO connections (id, name, provider, base_url, api_key, model, context_size,"
            " max_tokens, is_default, created_at, updated_at)"
            " VALUES (?, ?, 'openai-compatible', ?, '', 'brume-12b', 16384, 1024, 0, ?, ?)",
            (uuid.uuid4().hex, "Brume 12B", f"http://127.0.0.1:{mock_port}/lmstudio/v1", at, at))
        conn.commit()
    finally:
        conn.close()
    return path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("folder", type=Path)
    parser.add_argument("--mock-port", type=int, required=True)
    args = parser.parse_args()
    print(f"Wrote {write(args.folder, args.mock_port)}")
