"""The update that notes every call to a model: a table with no foreign key, the moment counting
starts, and a database the release before still runs on."""

import json
import re
import shutil
import sqlite3
from datetime import UTC, datetime

import pytest

from app import __version__, db
from app.config import db_path
from app.repositories import settings as settings_repo

MIGRATION = "023_calls.sql"
REAL_MIGRATIONS = db.MIGRATIONS_DIR

COLUMNS = [
    "id", "started_at", "ended_at", "purpose", "attempt", "outcome", "status", "conversation_id",
    "conversation_title", "card_id", "card_name", "card_kind", "job_id", "message_id", "variant",
    "model_id", "model_name", "service_id", "service_name", "family", "local", "loopback",
    "model_asked", "model_served", "upstream", "generation_id", "tokens_in", "tokens_out",
    "tokens_cached", "tokens_cache_write", "tokens_reasoning", "tokens_source", "price_in",
    "price_out", "price_cache_read", "price_cache_write", "price_source", "cost", "cost_upstream",
    "cost_source", "currency", "usage_raw", "reconciled_at",
]
INDEXES = {"calls_started", "calls_model", "calls_card", "calls_conversation", "calls_outcome",
           "calls_job"}


@pytest.fixture()
def start(tmp_path, monkeypatch):
    """Starts on the migrations that come before this update, then again with ``files`` added:
    the names of real migrations, or {name: sql} for one written by the test."""
    folder = tmp_path / "migrations"
    folder.mkdir()
    for path in REAL_MIGRATIONS.glob("*.sql"):
        if path.name < MIGRATION:
            shutil.copy(path, folder / path.name)
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", folder)

    async def start(*files):
        for item in files:
            if isinstance(item, dict):
                for name, sql in item.items():
                    (folder / name).write_text(sql, encoding="utf-8")
            else:
                shutil.copy(REAL_MIGRATIONS / item, folder / item)
        await db.init_db()

    start.folder = folder
    return start


def run(sql: str, params=()) -> None:
    conn = sqlite3.connect(db_path())
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def rows(sql: str, params=()) -> list[dict]:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def everything(*, apart: tuple[str, ...] = ()) -> dict:
    """Every table and every row of the database but ``apart``, to tell whether anything moved."""
    conn = sqlite3.connect(db_path())
    try:
        tables = [t for t in conn.execute(
            "SELECT type, name, sql, tbl_name FROM sqlite_master ORDER BY type, name").fetchall()
            if t[1] not in apart and t[3] != "calls"]
        return {"schema": tables, **{
            name: [r for r in conn.execute(f"SELECT * FROM {name} ORDER BY rowid").fetchall()
                   if not (name == "settings" and r[0] in apart)]
            for kind, name, *_ in tables if kind == "table"}}
    finally:
        conn.close()


async def test_the_calls_table_is_there_and_empty(start):
    await start()
    await start(MIGRATION)

    assert [r["name"] for r in rows("PRAGMA table_info(calls)")] == COLUMNS
    assert {r["name"] for r in rows("PRAGMA index_list(calls)")
            if r["origin"] == "c"} == INDEXES
    assert len(rows("PRAGMA index_list(calls)")) == 6 + 1  # plus the primary key's
    assert rows("SELECT * FROM calls") == []
    assert rows("PRAGMA foreign_key_list(calls)") == []


async def test_counting_starts_at_the_update(start):
    await start()
    before = datetime.now(UTC)

    await start(MIGRATION)

    stored = json.loads(rows("SELECT value FROM settings WHERE key = 'spending_since'")[0]["value"])
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00", stored)
    assert abs((datetime.fromisoformat(stored) - before).total_seconds()) < 5


async def test_an_id_of_digits_and_an_e_stays_text(start):
    await start()
    await start(MIGRATION)

    run("INSERT INTO calls (id, started_at, purpose, conversation_id)"
        " VALUES ('c1', '2026-11-25T14:03:05.123+00:00', 'reply', '12e4')")

    assert rows("SELECT typeof(conversation_id) AS t, conversation_id AS v FROM calls") == [
        {"t": "text", "v": "12e4"}]


async def test_nothing_else_changes(start):
    await start()
    run("INSERT INTO characters (id, name, created_at, updated_at)"
        " VALUES ('serana', 'Serana', '2026-01-01', '2026-01-01')")
    before = everything()

    await start(MIGRATION)

    # The migration is recorded as applied; the table, its indexes and the setting are the rest.
    after = everything(apart=("calls", "spending_since"))
    assert after["schema_migrations"] == before["schema_migrations"] + [(MIGRATION,)]
    after["schema_migrations"] = before["schema_migrations"]
    assert after == before


async def test_a_failure_half_way_leaves_the_database_as_it_was(start):
    await start()
    before = everything()

    with pytest.raises(sqlite3.IntegrityError):
        await start(MIGRATION, {
            "024_fails.sql": "INSERT INTO schema_migrations (name) VALUES ('001_init.sql');"})

    assert everything() == before
    assert not rows("SELECT name FROM sqlite_master WHERE name = 'calls'")
    assert not rows("SELECT key FROM settings WHERE key = 'spending_since'")

    (start.folder / "024_fails.sql").unlink()
    await start()

    assert [r["name"] for r in rows("PRAGMA table_info(calls)")] == COLUMNS
    assert rows("SELECT key FROM settings WHERE key = 'spending_since'")


async def test_the_copy_before_the_update_is_named_for_3_9_0(start):
    await start()
    run("INSERT INTO characters (id, name, created_at, updated_at)"
        " VALUES ('serana', 'Serana', '2026-01-01', '2026-01-01')")

    await start(MIGRATION)

    assert __version__ == "3.9.0"
    copy = db_path().with_name("evermind.before-3.9.0.db")
    assert copy.exists()
    conn = sqlite3.connect(copy)
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
    finally:
        conn.close()
    assert "calls" not in tables


async def test_3_8_starts_on_the_migrated_database(start, monkeypatch, tmp_path):
    await start()
    await start(MIGRATION)
    older = tmp_path / "3.8"
    older.mkdir()
    for path in REAL_MIGRATIONS.glob("*.sql"):
        if path.name < MIGRATION:
            shutil.copy(path, older / path.name)
    monkeypatch.setattr(db, "MIGRATIONS_DIR", older)

    await db.init_db()  # plays nothing and does not raise

    assert rows("SELECT name FROM sqlite_master WHERE name = 'calls'")
    conn = await db.connect()
    try:
        assert "spending_since" not in await settings_repo.get_all(conn)
    finally:
        await conn.close()
