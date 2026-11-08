"""The persona a conversation is played as when it names none.

There is one notion of it: the persona marked on the Personas page. It used to
be two (that mark, and a setting of its own), so a greeting could call the
player "User" while the turns that followed called them by a name; and nothing
the person chose could be undone, since a setting could not be cleared.
"""

import shutil
import sqlite3

import pytest

from app import db as app_db
from app.providers.base import ProviderEvent
from app.repositories.base import dumps

from .conftest import FakeProvider, send

SETTING = "default_persona_id"


@pytest.fixture()
def fake_provider(monkeypatch):
    FakeProvider.script = [
        ProviderEvent(type="delta", text="*She smiles.* Hello."),
        ProviderEvent(type="done"),
    ]
    FakeProvider.captured = {}
    monkeypatch.setattr("app.services.chat_service.get_provider", FakeProvider)
    monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
    return FakeProvider


async def make_persona(client, name, **fields):
    resp = await client.post("/api/personas", json={"name": name, **fields})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def marked(client) -> list[str]:
    return [p["name"] for p in (await client.get("/api/personas")).json() if p["is_default"]]


async def connect(client):
    resp = await client.post("/api/connections", json={
        "name": "Local", "provider": "openai-compatible",
        "base_url": "http://localhost:1234/v1", "model": "test",
    })
    assert resp.status_code == 201, resp.text


async def start(client, **fields):
    """A conversation with a character whose greeting names the player."""
    char = (await client.post("/api/characters", json={
        "name": "Serana", "greeting": "Hello {{user}}."})).json()
    resp = await client.post("/api/conversations", json={"character_id": char["id"], **fields})
    assert resp.status_code == 201, resp.text
    return resp.json()


def greeting(convo) -> str:
    return convo["messages"][0]["content"]


# ---------- who the player is ----------

async def test_the_greeting_and_the_turns_name_the_marked_persona(client, fake_provider):
    alex = await make_persona(client, "Alex")
    await connect(client)

    convo = await start(client)

    assert greeting(convo) == "Hello Alex."
    assert convo["persona_id"] == alex["id"]
    await send(client, convo["id"])
    assert "\nAlex:" in fake_provider.captured["payload"].stop


async def test_a_persona_asked_for_wins_over_the_marked_one(client, fake_provider):
    await make_persona(client, "Alex")
    morgan = await make_persona(client, "Morgan", is_default=False)
    await connect(client)

    convo = await start(client, persona_id=morgan["id"])

    assert greeting(convo) == "Hello Morgan."
    await send(client, convo["id"])
    assert "\nMorgan:" in fake_provider.captured["payload"].stop


async def test_a_persona_gone_by_the_time_the_conversation_starts_is_the_marked_one(client):
    await make_persona(client, "Alex")

    convo = await start(client, persona_id="no-longer-there")

    assert greeting(convo) == "Hello Alex."


async def test_with_none_marked_the_player_is_user_in_the_greeting_and_in_every_prompt(
        client, fake_provider):
    alex = await make_persona(client, "Alex")
    await make_persona(client, "Morgan")
    await connect(client)
    await client.put(f"/api/personas/{alex['id']}", json={"is_default": False})
    assert await marked(client) == []

    convo = await start(client)

    assert greeting(convo) == "Hello User."
    assert convo["persona_id"] is None

    await send(client, convo["id"])
    assert "\nUser:" in fake_provider.captured["payload"].stop

    extraction = '{"facts": [], "summary": "They met."}'
    fake_provider.script = [ProviderEvent(type="delta", text=extraction), ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.status_code == 200, resp.text
    payload = fake_provider.captured["payload"]
    assert "User (turn 1): Hello there" in payload.messages[0]["content"]
    assert "between User (the player) and Serana" in payload.system

    for i in range(8):
        await client.post(f"/api/conversations/{convo['id']}/memories",
                          json={"content": f"Fact number {i}."})
    await mark_facts_as_the_models()
    merged = '{"facts": [{"content": "All of it, merged."}]}'
    fake_provider.script = [ProviderEvent(type="delta", text=merged), ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/consolidate")
    assert resp.status_code == 200, resp.text
    assert "between User and Serana" in fake_provider.captured["payload"].system


async def mark_facts_as_the_models():
    """Marks every fact as the model's own, which are the ones consolidation may merge."""
    db = await app_db.connect()
    try:
        await db.execute("UPDATE memories SET source = 'auto'")
        await db.commit()
    finally:
        await db.close()


async def test_nothing_is_marked_after_the_marked_persona_is_deleted(client, fake_provider):
    first = await make_persona(client, "Alex")
    await make_persona(client, "Morgan")
    await connect(client)

    assert (await client.delete(f"/api/personas/{first['id']}")).status_code == 204

    # Not the oldest one left: "none" means none.
    assert await marked(client) == []
    convo = await start(client)
    assert greeting(convo) == "Hello User."
    await send(client, convo["id"])
    assert "\nUser:" in fake_provider.captured["payload"].stop


async def test_the_first_persona_made_is_marked_even_after_others_have_gone(client):
    first = await make_persona(client, "Alex")
    await client.delete(f"/api/personas/{first['id']}")

    await make_persona(client, "Morgan")

    assert await marked(client) == ["Morgan"]


async def test_a_conversation_whose_persona_is_gone_is_played_as_the_marked_one(
        client, fake_provider):
    await make_persona(client, "Alex")
    morgan = await make_persona(client, "Morgan")
    await connect(client)
    convo = await start(client, persona_id=morgan["id"])
    assert greeting(convo) == "Hello Morgan."

    await client.delete(f"/api/personas/{morgan['id']}")

    assert (await client.get(f"/api/conversations/{convo['id']}")).json()["persona_id"] is None
    await send(client, convo["id"])
    assert "\nAlex:" in fake_provider.captured["payload"].stop


# ---------- the settings are gone ----------

GONE = pytest.mark.parametrize("setting", [SETTING, "default_connection_id"])


@GONE
async def test_the_settings_no_longer_have_a_default_persona_or_connection(client, setting):
    settings = (await client.get("/api/settings")).json()
    assert setting not in settings

    resp = await client.put("/api/settings", json={setting: "anything"})

    assert resp.status_code == 200
    assert setting not in resp.json()
    assert setting not in (await client.get("/api/settings")).json()


@GONE
async def test_a_stored_default_persona_or_connection_does_not_come_back(client, setting):
    # What an older copy of the application left in the database.
    db = await app_db.connect()
    try:
        await db.execute("INSERT INTO settings (key, value) VALUES (?, ?)",
                         (setting, dumps("abc")))
        await db.commit()
    finally:
        await db.close()

    assert setting not in (await client.get("/api/settings")).json()
    assert setting not in (await client.put("/api/settings", json={"auto_memory": False})).json()


# ---------- a null changes no setting ----------

async def test_a_null_does_not_reset_a_setting_that_has_a_value_of_its_own_by_default(client):
    await client.put("/api/settings", json={
        "global_instructions": "In English.", "reply_length": "long", "auto_memory": False,
        "history_limit": 10, "passage_budget": 0, "update_check": False})

    kept = (await client.put("/api/settings", json={
        "global_instructions": None, "reply_length": None, "auto_memory": None,
        "history_limit": None, "passage_budget": None, "update_check": None})).json()

    assert kept["global_instructions"] == "In English."
    assert kept["reply_length"] == "long"
    assert kept["auto_memory"] is False
    assert kept["history_limit"] == 10
    assert kept["passage_budget"] == 0
    assert kept["update_check"] is False


# ---------- the migration ----------

BEFORE = "009_gate.sql"
THIS = "010_default_persona.sql"


@pytest.fixture()
def old_database(tmp_path, monkeypatch):
    """A database as the last release left it, before the default persona was
    one notion: migrations 001 to 009 applied, and nothing else.

    Returns ``(execute, start_before, upgrade)``: the first runs SQL on it and
    returns the rows, the second creates it, and the third starts the
    application on it with this migration and none after, as an update does.
    """
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "data"))

    def migrations_up_to(last):
        folder = tmp_path / f"migrations-up-to-{last}"
        folder.mkdir()
        for path in app_db.MIGRATIONS_DIR.glob("*.sql"):
            if path.name <= last:
                shutil.copy(path, folder / path.name)
        assert (folder / last).exists(), f"{last} is not among the migrations"
        return folder

    before, after = migrations_up_to(BEFORE), migrations_up_to(THIS)

    def execute(sql, *params):
        from app.config import db_path

        conn = sqlite3.connect(db_path())
        try:
            rows = conn.execute(sql, params).fetchall()
            conn.commit()
            return rows
        finally:
            conn.close()

    async def run(directory):
        monkeypatch.setattr(app_db, "MIGRATIONS_DIR", directory)
        await app_db.init_db()

    async def start_before():
        await run(before)

    async def upgrade():
        await run(after)

    return execute, start_before, upgrade


def seed_personas(execute, *rows):
    """``rows`` are ``(id, marked)``, or ``(id, marked, day)`` for the day of
    January 2026 the persona was made, the first day when it is left out."""
    for persona_id, is_default, *day in rows:
        created = f"2026-01-{day[0] if day else 1:02d}T00:00:00+00:00"
        execute(
            "INSERT INTO personas (id, name, is_default, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?)",
            persona_id, f"Name of {persona_id}", int(is_default), created, created)


def marks(execute) -> list[str]:
    return [r[0] for r in execute("SELECT id FROM personas WHERE is_default = 1 ORDER BY id")]


def stored(execute) -> list[str]:
    return [r[0] for r in execute("SELECT key FROM settings ORDER BY key")]


async def test_the_persona_the_setting_names_becomes_the_only_one_marked(old_database):
    execute, start_before, upgrade = old_database
    await start_before()
    seed_personas(execute, ("aaa", True), ("bbb", False), ("ccc", False))
    execute("INSERT INTO settings (key, value) VALUES (?, ?)", SETTING, dumps("ccc"))
    execute("INSERT INTO settings (key, value) VALUES (?, ?)", "reply_length", dumps("long"))

    await upgrade()

    assert marks(execute) == ["ccc"]
    assert stored(execute) == ["reply_length"]


async def test_the_persona_the_setting_names_is_marked_when_none_was_and_not_the_oldest(
        old_database):
    execute, start_before, upgrade = old_database
    await start_before()
    seed_personas(execute, ("aaa", False, 1), ("bbb", False, 2))
    execute("INSERT INTO settings (key, value) VALUES (?, ?)", SETTING, dumps("bbb"))

    await upgrade()

    assert marks(execute) == ["bbb"]
    assert stored(execute) == []


async def test_a_setting_naming_a_persona_that_is_gone_leaves_the_marks_alone(old_database):
    execute, start_before, upgrade = old_database
    await start_before()
    seed_personas(execute, ("bbb", True, 2), ("aaa", False, 1))
    execute("INSERT INTO settings (key, value) VALUES (?, ?)", SETTING, dumps("vanished"))

    await upgrade()

    assert marks(execute) == ["bbb"]
    assert stored(execute) == []


async def test_without_the_setting_the_marks_are_left_as_they_were(old_database):
    execute, start_before, upgrade = old_database
    await start_before()
    seed_personas(execute, ("aaa", False, 1), ("bbb", True, 2))

    await upgrade()

    assert marks(execute) == ["bbb"]


@pytest.mark.parametrize("setting", [None, dumps("vanished"), "", "not json {", "null", "42"])
async def test_with_none_marked_the_oldest_persona_is_marked_so_nobody_loses_the_one_they_played(
        old_database, setting):
    # Someone who deleted or unticked their default was being played as the oldest
    # persona. They keep that, and "None" becomes a choice they can make.
    execute, start_before, upgrade = old_database
    await start_before()
    seed_personas(execute, ("bbb", False, 5), ("ccc", False, 3), ("aaa", False, 9))
    if setting is not None:
        execute("INSERT INTO settings (key, value) VALUES (?, ?)", SETTING, setting)

    await upgrade()

    assert marks(execute) == ["ccc"]
    assert stored(execute) == []


async def test_the_oldest_persona_made_on_the_same_second_is_the_first_one_stored(old_database):
    execute, start_before, upgrade = old_database
    await start_before()
    seed_personas(execute, ("bbb", False, 2), ("aaa", False, 2))

    await upgrade()

    assert marks(execute) == ["bbb"]


async def test_a_database_without_personas_gets_none_marked(old_database):
    execute, start_before, upgrade = old_database
    await start_before()
    execute("INSERT INTO settings (key, value) VALUES (?, ?)", SETTING, dumps("vanished"))

    await upgrade()

    assert marks(execute) == []
    assert stored(execute) == []


@pytest.mark.parametrize("value", ["", "not json {", "null", "42", '["ccc"]', '{"id": "ccc"}',
                                   "ccc", '"ccc', '""'])
async def test_a_setting_that_is_not_a_persona_id_is_dropped_and_marks_nothing(
        old_database, value):
    execute, start_before, upgrade = old_database
    await start_before()
    seed_personas(execute, ("aaa", True), ("ccc", False))
    execute("INSERT INTO settings (key, value) VALUES (?, ?)", SETTING, value)

    await upgrade()

    assert marks(execute) == ["aaa"]
    assert stored(execute) == []
