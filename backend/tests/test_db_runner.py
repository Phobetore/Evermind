"""Starting on a database: the copy an update keeps, and all of its files running as one."""

import sqlite3

import pytest

from app import __version__, db
from app.config import db_path


@pytest.fixture()
def start(tmp_path, monkeypatch):
    """Adds migration files and starts the application again, on the same database."""
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", tmp_path)

    async def start(files):
        for name, sql in files.items():
            (tmp_path / name).write_text(sql, encoding="utf-8")
        await db.init_db()

    return start


def read(name, sql):
    conn = sqlite3.connect(db_path().with_name(name))
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


async def test_an_update_whose_second_file_fails_changes_nothing_and_keeps_a_copy(start):
    await start({"001.sql": "CREATE TABLE t (x); INSERT INTO t VALUES ('old');"})
    assert list(db_path().parent.glob("evermind.before-*")) == []
    copy = f"evermind.before-{__version__}.db"

    with pytest.raises(sqlite3.OperationalError):
        await start({"002.sql": "UPDATE t SET x = 'new';",
                     "003.sql": "INSERT INTO nowhere VALUES (1);"})

    assert read("evermind.db", "SELECT x FROM t") == [("old",)]
    assert read("evermind.db", "SELECT name FROM schema_migrations") == [("001.sql",)]
    assert read(copy, "SELECT x FROM t") == [("old",)]

    await start({"003.sql": "CREATE TABLE u (y);"})

    assert read("evermind.db", "SELECT x FROM t") == [("new",)]
    assert read("evermind.db", "SELECT name FROM schema_migrations ORDER BY name") == [
        ("001.sql",), ("002.sql",), ("003.sql",)]
    assert read(copy, "SELECT x FROM t") == [("old",)]


async def test_a_migration_cut_short_leaves_nothing_and_runs_whole_on_the_next_start(start):
    await start({"001.sql": "CREATE TABLE t (x);"})
    with pytest.raises(sqlite3.OperationalError):  # standing for a kill partway through
        await start({"002.sql": "CREATE TABLE u (y); INSERT INTO nowhere VALUES (1);"})

    await start({"002.sql": "CREATE TABLE u (y);"})

    assert read("evermind.db", "SELECT name FROM schema_migrations ORDER BY name") == [
        ("001.sql",), ("002.sql",)]


async def test_a_sqlite_older_than_3_35_stops_the_start_with_a_clear_message(start, monkeypatch):
    monkeypatch.setattr(sqlite3, "sqlite_version_info", (3, 34, 1))
    monkeypatch.setattr(sqlite3, "sqlite_version", "3.34.1")

    with pytest.raises(RuntimeError, match=r"SQLite 3\.35.*3\.34\.1.*Docker"):
        await start({"001.sql": "CREATE TABLE t (x);"})


async def test_rebuilding_a_table_in_a_migration_keeps_the_rows_that_point_at_it(start):
    await start({"001.sql": """
        CREATE TABLE p (id PRIMARY KEY); INSERT INTO p VALUES (1);
        CREATE TABLE c (p REFERENCES p (id) ON DELETE CASCADE); INSERT INTO c VALUES (1);"""})

    await start({"002.sql": """
        CREATE TABLE q (id PRIMARY KEY); INSERT INTO q SELECT * FROM p;
        DROP TABLE p; ALTER TABLE q RENAME TO p;"""})

    assert read("evermind.db", "SELECT p FROM c") == [(1,)]
