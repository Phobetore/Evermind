"""What a start does to the database: each new migration file runs whole or not at all,
with foreign keys off."""

import sqlite3

import pytest

from app import db
from app.config import db_path


@pytest.fixture()
def start(tmp_path, monkeypatch):
    """Adds a migration file and starts the application again, on the same database."""
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", tmp_path)

    async def start(name, sql):
        (tmp_path / name).write_text(sql, encoding="utf-8")
        await db.init_db()

    return start


def read(name, sql):
    conn = sqlite3.connect(db_path().with_name(name))
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


async def test_a_migration_cut_short_leaves_nothing_and_runs_whole_on_the_next_start(start):
    await start("001.sql", "CREATE TABLE t (x);")
    with pytest.raises(sqlite3.OperationalError):  # standing for a kill partway through
        await start("002.sql", "CREATE TABLE u (y); INSERT INTO nowhere VALUES (1);")

    await start("002.sql", "CREATE TABLE u (y);")

    assert read("evermind.db", "SELECT name FROM schema_migrations ORDER BY name") == [
        ("001.sql",), ("002.sql",)]


async def test_a_table_a_migration_rebuilds_keeps_the_rows_that_point_at_it(start):
    await start("001.sql", "CREATE TABLE p (id PRIMARY KEY); INSERT INTO p VALUES (1);"
                " CREATE TABLE c (p REFERENCES p (id) ON DELETE CASCADE); INSERT INTO c VALUES (1);")

    await start("002.sql", "CREATE TABLE q (id PRIMARY KEY); INSERT INTO q SELECT * FROM p;"
                " DROP TABLE p; ALTER TABLE q RENAME TO p;")

    assert read("evermind.db", "SELECT p FROM c") == [(1,)]
