"""The update to the ways of playing: the three settings that were the way of playing become
"balanced" or a way of their own, every conversation plays as it did, and a database the release
before still runs on."""

import json
import shutil
import sqlite3

import pytest

from app import db
from app.config import db_path

MIGRATION = "022_ways_of_playing.sql"
REAL_MIGRATIONS = db.MIGRATIONS_DIR

MINE = {"id": "mine", "name": None, "history_limit": 40, "reply_length": "long",
        "reply_room": 2048, "facts_cap": 2000, "max_facts": 60, "lore_cap": 800,
        "lore_share": None, "passage_cap": 3000, "passage_share": None}


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


def everything() -> dict:
    """Every table and every row of the database, to tell whether anything moved."""
    conn = sqlite3.connect(db_path())
    try:
        tables = conn.execute(
            "SELECT type, name, sql FROM sqlite_master ORDER BY type, name").fetchall()
        return {"schema": tables, **{
            name: conn.execute(f"SELECT * FROM {name} ORDER BY rowid").fetchall()
            for kind, name, _ in tables if kind == "table"}}
    finally:
        conn.close()


def setting(key: str, value) -> None:
    run("INSERT INTO settings (key, value) VALUES (?, ?)", (key, json.dumps(value)))


def stored(key: str):
    found = rows("SELECT value FROM settings WHERE key = ?", (key,))
    return json.loads(found[0]["value"]) if found else None


def conversations(count: int = 3) -> list[str]:
    run("INSERT INTO characters (id, name, created_at, updated_at)"
        " VALUES ('serana', 'Serana', '2026-01-01', '2026-01-01')")
    ids = [f"x{n}" for n in range(count)]
    for convo_id in ids:
        run("INSERT INTO conversations (id, character_id, created_at, updated_at)"
            " VALUES (?, 'serana', '2026-01-02', '2026-01-02')", (convo_id,))
    return ids


def played() -> dict[str, tuple]:
    return {r["id"]: (r["play_style"], r["play_overrides"])
            for r in rows("SELECT id, play_style, play_overrides FROM conversations")}


def ai(ai_id: str, name: str, base_url: str, model: str) -> None:
    """An AI on a service of its own, as the update before left them."""
    run("INSERT INTO connections (id, name, provider, base_url, api_key, model, context_size,"
        " created_at, updated_at) VALUES (?, ?, 'openai-compatible', ?, '', ?, 8192,"
        " '2026-01-01', '2026-01-01')", (ai_id, name, base_url, model))
    run("INSERT INTO models (id, connection_id, model, name, context_own, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, 8192, '2026-01-01', '2026-01-01')", (ai_id, ai_id, model, name))


async def test_untouched_settings_play_balanced(start):
    await start()
    ids = conversations()

    await start(MIGRATION)

    assert stored("default_play_style") == "balanced"
    assert stored("play_styles") == {"overrides": {}, "custom": []}
    assert played() == {convo_id: ("balanced", None) for convo_id in ids}


async def test_settings_left_at_their_values_play_balanced(start):
    await start()
    setting("reply_length", "medium")
    setting("history_limit", 24)
    setting("passage_budget", 1500)
    ids = conversations()

    await start(MIGRATION)

    assert stored("default_play_style") == "balanced"
    assert stored("play_styles") == {"overrides": {}, "custom": []}
    assert played() == {convo_id: ("balanced", None) for convo_id in ids}


async def test_touched_settings_become_my_settings_offered_to_new_conversations(start):
    await start()
    setting("reply_length", "long")
    setting("history_limit", 40)
    setting("passage_budget", 3000)
    ids = conversations()

    await start(MIGRATION)

    assert stored("default_play_style") == "mine"
    assert stored("play_styles") == {"overrides": {}, "custom": [MINE]}
    assert played() == {convo_id: ("mine", None) for convo_id in ids}


async def test_the_room_of_my_settings_is_its_length_s(start):
    await start()
    setting("reply_length", "short")
    await start(MIGRATION)
    assert stored("play_styles")["custom"][0]["reply_room"] == 512


async def test_a_medium_length_with_other_figures_keeps_1024(start):
    await start()
    setting("history_limit", 30)

    await start(MIGRATION)

    custom = stored("play_styles")["custom"][0]
    assert (custom["reply_room"], custom["history_limit"], custom["passage_cap"]) == (
        1024, 30, 1500)


async def test_the_old_settings_stay_for_the_release_before(start):
    await start()
    setting("reply_length", "long")
    setting("history_limit", 40)
    setting("passage_budget", 3000)

    await start(MIGRATION)

    assert (stored("reply_length"), stored("history_limit"), stored("passage_budget")) == (
        "long", 40, 3000)


async def test_a_setting_that_is_not_json_does_not_stop_the_update(start):
    await start()
    run("INSERT INTO settings (key, value) VALUES ('history_limit', 'not json')")
    ids = conversations(1)

    await start(MIGRATION)

    # 3.7 read a value that is not JSON as nothing, and int(nothing or 0) is no limit.
    assert stored("default_play_style") == "mine"
    assert stored("play_styles")["custom"][0]["history_limit"] == 0
    assert played() == {ids[0]: ("mine", None)}


WHOLE = 2 ** 53 - 1
# Each stored form of the three settings (as the settings table holds it: JSON, or not), and the
# figure of "mine" that plays what 3.7 played with it; None: 3.7 played balanced's figures (the
# default, or a value it could not read, which stopped every turn).
STORED_FORMS = [
    # history_limit: int(value or 0), 0 rereading the whole story.
    ("history_limit", "30", 30), ("history_limit", '"30"', 30), ("history_limit", '" 30 "', 30),
    ("history_limit", '"+30"', 30), ("history_limit", "30.5", 30), ("history_limit", "30.0", 30),
    ("history_limit", "-0.5", 0), ("history_limit", "null", 0), ("history_limit", "not json", 0),
    ("history_limit", "", 0), ("history_limit", '""', 0), ("history_limit", "{}", 0),
    ("history_limit", "[]", 0), ("history_limit", "false", 0), ("history_limit", "0", 0),
    ("history_limit", "true", 1), ("history_limit", "1e300", 0),
    ("history_limit", "99999999999999999999", 0), ("history_limit", '"99999999999999999999"', 0),
    ("history_limit", "24", None), ("history_limit", '"24"', None),
    ("history_limit", '"thirty"', None), ("history_limit", '"30.5"', None),
    ("history_limit", '"  "', None), ("history_limit", '"+"', None), ("history_limit", '"3-0"', None),
    ("history_limit", '{"a": 1}', None), ("history_limit", "[1]", None),
    ("history_limit", "-5", None), ("history_limit", '"-3"', None), ("history_limit", "NaN", None),
    # passage_budget: the same reading, 0 sending no passage.
    ("passage_budget", "800", 800), ("passage_budget", '"800"', 800), ("passage_budget", "2.9", 2),
    ("passage_budget", "null", 0), ("passage_budget", "not json", 0), ("passage_budget", "[]", 0),
    ("passage_budget", "-5", 0), ("passage_budget", "true", 1), ("passage_budget", "1e300", WHOLE),
    ("passage_budget", "1500", None), ("passage_budget", '"x"', None),
    ("passage_budget", '{"a": 1}', None), ("passage_budget", "Infinity", None),
    # reply_length: a length 3.7 did not know played medium, with no instruction and its room.
    ("reply_length", '"long"', "long"), ("reply_length", '"short"', "short"),
    ("reply_length", '"medium"', None), ("reply_length", '"huge"', None),
    ("reply_length", '"Long"', None), ("reply_length", "5", None), ("reply_length", "null", None),
    ("reply_length", "not json", None), ("reply_length", '["long"]', None),
    ("reply_length", '{"a": 1}', None),
]
_FIELD = {"history_limit": "history_limit", "passage_budget": "passage_cap",
          "reply_length": "reply_length"}


@pytest.mark.parametrize("key,value,figure", STORED_FORMS)
async def test_each_stored_form_plays_what_3_7_played(start, key, value, figure):
    await start()
    run("INSERT INTO settings (key, value) VALUES (?, ?)", (key, value))
    ids = conversations(1)

    await start(MIGRATION)

    if figure is None:
        assert stored("default_play_style") == "balanced"
        assert stored("play_styles") == {"overrides": {}, "custom": []}
        assert played() == {ids[0]: ("balanced", None)}
        return
    assert stored("default_play_style") == "mine"
    mine = stored("play_styles")["custom"][0]
    assert mine[_FIELD[key]] == figure
    expected = {"history_limit": 24, "reply_length": "medium", "passage_cap": 1500}
    expected[_FIELD[key]] = figure
    assert {k: mine[k] for k in expected} == expected
    assert mine["reply_room"] == {"short": 512, "medium": 1024, "long": 2048}[mine["reply_length"]]
    assert played() == {ids[0]: ("mine", None)}
    # What the update wrote, the engine plays as it is.
    from app.prompting import ways
    assert {k: v for k, v in ways.way_of(stored("play_styles"), "mine", None).items()
            if k in mine} == {**mine}


async def test_a_value_of_each_setting_at_its_default_plays_balanced(start):
    await start()
    run("INSERT INTO settings (key, value) VALUES ('reply_length', '\"medium\"')")
    run("INSERT INTO settings (key, value) VALUES ('history_limit', '\"24\"')")
    run("INSERT INTO settings (key, value) VALUES ('passage_budget', '1500.0')")
    await start(MIGRATION)
    assert stored("default_play_style") == "balanced"
    assert stored("play_styles") == {"overrides": {}, "custom": []}


async def test_a_model_has_not_said_what_it_counts_yet(start):
    await start()
    ai("c1", "Brume", "http://localhost:11434/v1", "brume:12b")
    ai("c2", "Sylve", "http://localhost:1234/v1", "sylve-7b")

    await start(MIGRATION)

    assert rows("SELECT id, usage_seen FROM models ORDER BY id") == [
        {"id": "c1", "usage_seen": None}, {"id": "c2", "usage_seen": None}]


async def test_a_model_says_it_counts_or_it_does_not_and_nothing_else(start):
    await start()
    ai("c1", "Brume", "http://localhost:11434/v1", "brume:12b")
    await start(MIGRATION)

    run("UPDATE models SET usage_seen = 0")
    run("UPDATE models SET usage_seen = 1")
    with pytest.raises(sqlite3.IntegrityError):
        run("UPDATE models SET usage_seen = 2")
    assert rows("SELECT usage_seen FROM models") == [{"usage_seen": 1}]


async def test_a_failure_half_way_leaves_the_database_as_it_was(start):
    await start()
    setting("history_limit", 40)
    conversations(2)
    before = everything()

    with pytest.raises(sqlite3.IntegrityError):
        await start(MIGRATION, {
            "023_fails.sql": "INSERT INTO schema_migrations (name) VALUES ('001_init.sql');"})

    assert everything() == before
    assert not [r for r in rows("PRAGMA table_info(conversations)") if r["name"] == "play_style"]
    assert (MIGRATION,) not in before["schema_migrations"]

    (start.folder / "023_fails.sql").unlink()
    await start()

    assert set(played().values()) == {("mine", None)}


async def test_the_copy_before_the_update_is_named_for_3_8_0(start, monkeypatch):
    # The copy takes the running release's number: this is the release that made the update.
    monkeypatch.setattr(db, "__version__", "3.8.0")
    await start()
    conversations(1)

    await start(MIGRATION)

    copy = db_path().with_name("evermind.before-3.8.0.db")
    assert copy.exists()
    conn = sqlite3.connect(copy)
    try:
        columns = [r[1] for r in conn.execute("PRAGMA table_info(conversations)")]
    finally:
        conn.close()
    assert "play_style" not in columns


async def test_a_conversation_the_release_before_makes_after_the_update_plays_balanced(start):
    # 3.7.0 run again on the migrated database knows no play_style: the column's default is what
    # such a row gets, whatever the way the settings became. The update never runs a second time,
    # so this is said in the upgrade note, not mended.
    await start()
    setting("history_limit", 40)
    await start(MIGRATION)
    assert stored("default_play_style") == "mine"
    run("INSERT INTO characters (id, name, created_at, updated_at)"
        " VALUES ('serana', 'Serana', '2026-01-01', '2026-01-01')")

    run("INSERT INTO conversations (id, character_id, created_at, updated_at)"
        " VALUES ('later', 'serana', '2026-01-03', '2026-01-03')")

    assert played() == {"later": ("balanced", None)}
