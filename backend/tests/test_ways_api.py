"""The ways of playing through the API: what is listed, what a conversation plays and keeps, what
another device changes, what an update keeps, and what a page from before can no longer write."""

import asyncio
import json
import shutil
import sqlite3

import httpx
import pytest

from app import db
from app.config import db_path
from app.prompting import embeddings
from app.repositories import ways as ways_repo
from app.services import ai_call

from .helpers import add_model, cap
from .test_memory_room import writing
from .test_my_ais_api import LMSTUDIO, Model, conversation_on, model_of, open_db

SHORT = "LENGTH OVERRIDE: keep every reply to ONE tight paragraph"
LONG = "LENGTH OVERRIDE: write expansive replies"
MIGRATION = "022_ways_of_playing.sql"


async def an_ai(client, **fields) -> dict:
    """An AI on a server at home that sends no ceiling, unless ``fields`` say otherwise."""
    return await add_model(client, base_url=LMSTUDIO, **fields)


async def no_memory_pass(client) -> None:
    # A pass after a long story would ask the model too, and its body would be counted.
    resp = await client.put("/api/settings", json={"auto_memory": False})
    assert resp.status_code == 200, resp.text


async def story(convo_id: str, count: int) -> None:
    """``count`` messages after the greeting, by SQL: a long story without a turn for each."""
    conn = await open_db()
    try:
        row = await (await conn.execute(
            "SELECT COALESCE(MAX(position), -1) AS p FROM messages WHERE conversation_id = ?",
            (convo_id,))).fetchone()
        start = row["p"] + 1
        for n in range(count):
            role = "user" if (start + n) % 2 else "assistant"
            await conn.execute(
                "INSERT INTO messages (id, conversation_id, role, variants, position, meta,"
                " created_at) VALUES (?, ?, ?, ?, ?, '{}', '2026-11-01T10:00:00+00:00')",
                (f"{convo_id}-{start + n}", convo_id, role, json.dumps([f"Line {start + n}."]),
                 start + n))
        await conn.commit()
    finally:
        await conn.close()


async def sql(statement: str, params=()) -> None:
    conn = await open_db()
    try:
        await conn.execute(statement, params)
        await conn.commit()
    finally:
        await conn.close()


async def turn(client, convo_id: str, model: Model) -> dict:
    """One turn; the body its model was sent."""
    sent = len(model.bodies)
    resp = await client.post("/api/chat", json={
        "conversation_id": convo_id, "mode": "send", "content": "And then?"})
    assert resp.status_code == 200, resp.text
    from app.services import turns

    if running := await turns.running_for(convo_id):
        await running.finished.wait()
    outcome = (await client.get(f"/api/conversations/{convo_id}/turn")).json()["outcome"]
    assert outcome is None, outcome
    assert len(model.bodies) == sent + 1
    return model.bodies[-1]


def history_of(body: dict) -> int:
    """The story's messages in a body: all but the system prompt."""
    return len(body["messages"]) - 1


async def context_of(client, convo_id: str) -> dict:
    messages = (await client.get(f"/api/conversations/{convo_id}")).json()["messages"]
    return messages[-1]["meta"]["context"]


async def listing(client) -> dict:
    resp = await client.get("/api/ways")
    assert resp.status_code == 200, resp.text
    return resp.json()


def way_in(listed: dict, way_id: str) -> dict:
    return next(w for w in listed["ways"] if w["id"] == way_id)


async def patch(client, convo_id: str, **body) -> dict:
    resp = await client.patch(f"/api/conversations/{convo_id}", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def copy_of(client, from_id: str = "balanced", name: str = "Mine") -> dict:
    resp = await client.post("/api/ways", json={"from": from_id, "name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_the_four_ways_are_listed_with_their_conversations(client):
    made = [await conversation_on(client) for _ in range(4)]
    await patch(client, made[3]["id"], play_style="light")

    listed = await listing(client)

    assert [w["id"] for w in listed["ways"]] == ["light", "balanced", "immersive", "maximum"]
    assert way_in(listed, "balanced")["conversations"] == 3
    assert way_in(listed, "light")["conversations"] == 1
    assert listed["default"] == "balanced"
    assert listed["passages_available"] is embeddings.installed()
    assert way_in(listed, "light")["history_limit"] == 16
    assert way_in(listed, "light")["built_in"] and not way_in(listed, "light")["overridden"]


async def test_a_way_is_played_by_the_next_turn(client, monkeypatch):
    await no_memory_pass(client)
    ai = await an_ai(client)
    convo = await conversation_on(client, ai["id"], play_style="light")
    await story(convo["id"], 30)
    model = Model(writing("*She nods.*")).serve(monkeypatch)

    body = await turn(client, convo["id"], model)

    assert history_of(body) == 16
    assert SHORT in body["messages"][0]["content"]
    context = await context_of(client, convo["id"])
    assert context["history_limit"] == 16
    assert context["reply_room"] == ai_call.UNSENT_RESERVE  # the AI's, which sends no ceiling
    assert set(context["parts"]) == {"card", "reminders", "history"}


async def test_a_conversation_keeps_the_way_it_was_made_with(client, monkeypatch):
    await no_memory_pass(client)
    ai = await an_ai(client)
    before = await conversation_on(client, ai["id"])
    resp = await client.put("/api/ways/default", json={"id": "immersive"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["default"] == "immersive"
    after = await conversation_on(client, ai["id"])
    model = Model(writing("*She nods.*")).serve(monkeypatch)

    assert before["play_style"] == "balanced" and before["play_overrides"] is None
    assert after["play_style"] == "immersive"
    assert LONG not in (await turn(client, before["id"], model))["messages"][0]["content"]
    assert LONG in (await turn(client, after["id"], model))["messages"][0]["content"]


async def test_a_conversation_made_with_an_unknown_way_is_not_found(client):
    character = (await client.post("/api/characters", json={"name": "Serana"})).json()
    resp = await client.post("/api/conversations", json={"character_id": character["id"],
                                                         "play_style": "gone"})
    assert resp.status_code == 404
    assert resp.json()["resource"] == "way"
    assert (await client.get("/api/conversations")).json() == []


async def test_picking_another_way_clears_the_overrides(client):
    convo = await conversation_on(client)
    assert (await patch(client, convo["id"], play_overrides={"reply_length": "long"}))[
        "play_overrides"] == {"reply_length": "long"}

    picked = await patch(client, convo["id"], play_style="light")

    assert picked["play_style"] == "light" and picked["play_overrides"] is None
    resp = await client.patch(f"/api/conversations/{convo['id']}", json={"play_style": "gone"})
    assert resp.status_code == 404 and resp.json()["resource"] == "way"


async def test_an_override_equal_to_the_way_is_not_kept(client):
    convo = await conversation_on(client)

    kept = await patch(client, convo["id"], play_overrides={"history_limit": 24,
                                                            "reply_length": "long"})
    assert kept["play_overrides"] == {"reply_length": "long"}
    assert (await patch(client, convo["id"], play_overrides={"history_limit": 24}))[
        "play_overrides"] is None
    assert (await patch(client, convo["id"], play_overrides={"reminders": "rich"}))[
        "play_overrides"] == {"reminders": "rich"}
    assert (await patch(client, convo["id"], play_overrides={"reminders": "normal"}))[
        "play_overrides"] is None
    assert (await patch(client, convo["id"], play_overrides=None))["play_overrides"] is None
    resp = await client.patch(f"/api/conversations/{convo['id']}",
                              json={"play_overrides": {"history_limit": -1}})
    assert resp.status_code == 422


async def test_a_way_changed_elsewhere_applies_to_the_next_turn(client, monkeypatch):
    await no_memory_pass(client)
    ai = await an_ai(client)
    convo = await conversation_on(client, ai["id"])
    await story(convo["id"], 10)
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    assert history_of(await turn(client, convo["id"], model)) > 4

    resp = await client.put("/api/ways/balanced", json={"history_limit": 4})
    assert resp.status_code == 200, resp.text

    assert history_of(await turn(client, convo["id"], model)) == 4


async def test_two_devices_changing_two_ways_keep_both(make_client):
    async with make_client() as one, make_client() as other:
        answers = await asyncio.gather(
            one.put("/api/ways/light", json={"history_limit": 10}),
            other.put("/api/ways/immersive", json={"history_limit": 80}))
        assert [a.status_code for a in answers] == [200, 200]
        listed = await listing(one)
    assert way_in(listed, "light")["history_limit"] == 10
    assert way_in(listed, "immersive")["history_limit"] == 80


async def test_removing_a_way_moves_its_conversations_to_the_default_in_one_transaction(
        client, monkeypatch):
    mine = await copy_of(client)
    made = [await conversation_on(client) for _ in range(3)]
    for convo in made:
        await patch(client, convo["id"], play_style=mine["id"])
    await patch(client, made[0]["id"], play_overrides={"reply_length": "short"})

    async def broken(*_):
        raise RuntimeError("the disk went away")

    with monkeypatch.context() as patched:
        patched.setattr(ways_repo, "_move", broken)
        with pytest.raises(RuntimeError):
            await client.delete(f"/api/ways/{mine['id']}")
    assert way_in(await listing(client), mine["id"])["conversations"] == 3

    resp = await client.delete(f"/api/ways/{mine['id']}")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"moved": 3, "to": "balanced"}

    listed = await listing(client)
    assert mine["id"] not in [w["id"] for w in listed["ways"]]
    assert way_in(listed, "balanced")["conversations"] == 3
    played = [(await client.get(f"/api/conversations/{c['id']}")).json() for c in made]
    assert [p["play_style"] for p in played] == ["balanced"] * 3
    assert played[0]["play_overrides"] == {"reply_length": "short"}


async def test_removing_the_default_way_offers_balanced(client):
    mine = await copy_of(client, "light")
    resp = await client.put("/api/ways/default", json={"id": mine["id"]})
    assert resp.status_code == 200, resp.text
    convo = await conversation_on(client)
    assert convo["play_style"] == mine["id"]

    resp = await client.delete(f"/api/ways/{mine['id']}")

    assert resp.json() == {"moved": 1, "to": "balanced"}
    assert (await listing(client))["default"] == "balanced"
    # What is stored, not only what it reads as: the next device reads the setting as it is.
    assert (await client.get("/api/settings")).json()["default_play_style"] == "balanced"


async def test_a_built_in_way_cannot_be_removed(client):
    resp = await client.delete("/api/ways/light")
    assert resp.status_code == 409
    assert resp.json()["kind"] == "way_built_in"
    assert "light" in [w["id"] for w in (await listing(client))["ways"]]
    resp = await client.delete("/api/ways/gone")
    assert resp.status_code == 404 and resp.json()["resource"] == "way"


async def test_an_unknown_way_plays_as_the_default_then_balanced(client, monkeypatch):
    await no_memory_pass(client)
    ai = await an_ai(client)
    resp = await client.put("/api/ways/default", json={"id": "light"})
    assert resp.status_code == 200, resp.text
    convo = await conversation_on(client, ai["id"])
    await story(convo["id"], 30)
    await sql("UPDATE conversations SET play_style = 'gone' WHERE id = ?", (convo["id"],))
    model = Model(writing("*She nods.*")).serve(monkeypatch)

    body = await turn(client, convo["id"], model)
    assert history_of(body) == 16 and SHORT in body["messages"][0]["content"]
    assert way_in(await listing(client), "light")["conversations"] == 1

    await sql("UPDATE settings SET value = ? WHERE key = 'default_play_style'",
              (json.dumps("gone-too"),))
    body = await turn(client, convo["id"], model)
    assert history_of(body) == 24
    assert "LENGTH OVERRIDE" not in body["messages"][0]["content"]
    # Settings marks the way offered from the listing; a new conversation plays it.
    assert (await listing(client))["default"] == "balanced"
    assert (await conversation_on(client, ai["id"]))["play_style"] == "balanced"


async def test_reset_brings_back_the_original_values(client):
    resp = await client.put("/api/ways/balanced", json={"history_limit": 30})
    assert resp.status_code == 200, resp.text
    assert resp.json()["overridden"] and resp.json()["history_limit"] == 30

    resp = await client.post("/api/ways/balanced/reset")
    assert resp.status_code == 200, resp.text
    assert resp.json()["history_limit"] == 24 and not resp.json()["overridden"]
    stored = (await client.get("/api/settings")).json()["play_styles"]
    assert "balanced" not in stored["overrides"]


async def test_a_change_back_to_the_original_value_is_not_kept(client):
    await client.put("/api/ways/light", json={"history_limit": 30, "reply_length": "long"})
    resp = await client.put("/api/ways/light", json={"history_limit": 16})
    assert resp.json()["overridden"]
    stored = (await client.get("/api/settings")).json()["play_styles"]
    assert stored["overrides"]["light"] == {"reply_length": "long"}
    resp = await client.put("/api/ways/light", json={"name": "Mine"})
    assert resp.status_code == 409 and resp.json()["kind"] == "way_built_in"


async def test_a_custom_way_is_renamed_and_changed(client):
    mine = await copy_of(client, "immersive", "  Long nights  ")
    assert mine["name"] == "Long nights" and not mine["built_in"]
    assert mine["history_limit"] == 60 and mine["conversations"] == 0

    resp = await client.put(f"/api/ways/{mine['id']}", json={"name": "Nights",
                                                             "reply_room": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Nights" and resp.json()["reply_room"] is None
    resp = await client.put(f"/api/ways/{mine['id']}", json={"name": None})
    assert resp.status_code == 422
    assert way_in(await listing(client), mine["id"])["name"] == "Nights"
    assert (await client.put("/api/ways/gone", json={"history_limit": 3})).status_code == 404
    assert (await client.post("/api/ways", json={"from": "gone", "name": "X"})).status_code == 404
    assert (await client.post("/api/ways", json={"from": "light", "name": "  "})).status_code == 422


async def test_no_upper_bound_only_floors(client):
    assert (await client.put("/api/ways/balanced", json={"history_limit": 5000})).status_code == 200
    for refused in ({"history_limit": -1}, {"reply_room": 0}, {"lore_share": 1.5},
                    {"max_facts": 0}, {"facts_cap": -1}, {"passage_share": -0.1},
                    {"reply_length": "endless"}, {"history_limit": 2**53},
                    # A null here would be kept and handed to the next turn as its value.
                    {"history_limit": None}, {"reply_length": None}):
        resp = await client.put("/api/ways/balanced", json=refused)
        assert resp.status_code == 422, refused
    listed = way_in(await listing(client), "balanced")
    assert listed["history_limit"] == 5000 and listed["reply_length"] == "medium"


async def test_a_page_from_before_cannot_set_the_three_old_settings(client):
    for old in ({"history_limit": 30}, {"reply_length": "long"}, {"passage_budget": 99999},
                {"auto_memory": False, "history_limit": 2}):
        resp = await client.put("/api/settings", json=old)
        assert resp.status_code == 410, old
        assert resp.json()["kind"] == "page_outdated"
    settings = (await client.get("/api/settings")).json()
    assert settings["auto_memory"] is True
    assert not {"history_limit", "reply_length", "passage_budget"} & set(settings)
    conn = await open_db()
    try:
        rows = await (await conn.execute("SELECT key FROM settings")).fetchall()
    finally:
        await conn.close()
    assert not {"history_limit", "reply_length", "passage_budget"} & {r["key"] for r in rows}

    resp = await client.put("/api/settings", json={"auto_memory": False})
    assert resp.status_code == 200
    assert resp.json()["auto_memory"] is False
    # The ways are written by their own routes only.
    resp = await client.put("/api/settings", json={"default_play_style": "light"})
    assert resp.status_code == 200
    assert (await listing(client))["default"] == "balanced"


async def test_unsent_keeps_1024_whatever_the_way(client, monkeypatch):
    await no_memory_pass(client)
    ai = await an_ai(client)
    convo = await conversation_on(client, ai["id"], play_style="immersive")
    model = Model(writing("*She nods.*")).serve(monkeypatch)

    body = await turn(client, convo["id"], model)

    assert "max_tokens" not in body
    assert (await context_of(client, convo["id"]))["reply_room"] == 1024


async def test_auto_takes_the_room_of_the_way(client, monkeypatch):
    await no_memory_pass(client)
    ai = await an_ai(client, reply_cap={"mode": "auto"})
    convo = await conversation_on(client, ai["id"], play_style="immersive")
    light = await conversation_on(client, ai["id"], play_style="light")
    model = Model(writing("*She nods.*")).serve(monkeypatch)

    assert (await turn(client, convo["id"], model))["max_tokens"] == 2048
    assert (await turn(client, light["id"], model))["max_tokens"] == 512
    await patch(client, light["id"], play_overrides={"reply_length": "medium"})
    assert (await turn(client, light["id"], model))["max_tokens"] == 1024


async def test_the_long_room_notice(client):
    ai = await an_ai(client)
    assert "long_room" not in (await model_of(client, ai["id"]))["notices"]

    await client.put("/api/ways/default", json={"id": "immersive"})
    assert "long_room" in (await model_of(client, ai["id"]))["notices"]

    resp = await client.put(f"/api/models/{ai['id']}", json={"notices_kept": True})
    assert resp.status_code == 200, resp.text
    assert (await model_of(client, ai["id"]))["notices"] == []
    capped = await an_ai(client, model="other", **cap(1024))
    assert "long_room" not in (await model_of(client, capped["id"]))["notices"]


def test_the_margin_follows_what_was_measured():
    assert ai_call.margin_for({"token_ratio_n": 0}, 16384) == 983
    assert ai_call.margin_for({}, 16384) == 983
    assert ai_call.margin_for({"token_ratio_n": 3}, 16384) == 491
    assert ai_call.margin_for({"token_ratio_n": 3, "fit_margin": 0.10}, 16384) == 491 + 1638
    assert ai_call.margin_for({"token_ratio_n": 0}, 2048) == 200


def test_the_ratio_reaches_the_engine_once_measured():
    service = {"provider": "openai-compatible", "base_url": LMSTUDIO, "api_key": ""}
    model = {"id": "m", "name": "M", "model": "m", "context_own": 16384,
             "reply_cap_mode": "unsent", "token_ratio": 1.2, "token_ratio_n": 0}
    call = ai_call.call_for(model, service, room=1024)
    assert call["token_ratio"] is None and call["margin"] == 983
    call = ai_call.call_for({**model, "token_ratio_n": 2}, service, room=1024)
    assert call["token_ratio"] == 1.2 and call["margin"] == 491
    engine = ai_call.for_engine(call)
    assert (engine["margin"], engine["token_ratio"]) == (491, 1.2)


async def test_a_branch_keeps_its_way_and_its_overrides(client):
    convo = await conversation_on(client, play_style="immersive")
    await patch(client, convo["id"], play_overrides={"reply_length": "short"})
    message = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"][0]

    resp = await client.post(f"/api/messages/{message['id']}/branch")

    assert resp.status_code == 201, resp.text
    branch = resp.json()
    assert branch["play_style"] == "immersive"
    assert branch["play_overrides"] == {"reply_length": "short"}


@pytest.fixture()
def before_ways(tmp_path, monkeypatch):
    """A database left by 3.7.0: every migration before this update's."""
    folder = tmp_path / "migrations"
    folder.mkdir()
    real = db.MIGRATIONS_DIR
    for path in real.glob("*.sql"):
        if path.name < MIGRATION:
            shutil.copy(path, folder / path.name)
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", folder)

    def update():
        shutil.copy(real / MIGRATION, folder / MIGRATION)

    return update


async def test_my_settings_keep_the_room_an_auto_ai_had(before_ways, monkeypatch):
    await db.init_db()
    conn = sqlite3.connect(db_path())
    try:
        for key, value in (("reply_length", "long"), ("history_limit", 30),
                           ("passage_budget", 1500)):
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?)",
                         (key, json.dumps(value)))
        at = "2026-11-01T10:00:00+00:00"
        conn.execute("INSERT INTO connections (id, name, provider, base_url, api_key, model,"
                     " created_at, updated_at) VALUES ('s1', 'Home', 'openai-compatible', ?, '',"
                     " 'brume', ?, ?)", (LMSTUDIO, at, at))
        # An AI Evermind sets, on a model that does not reason: 3.7.0 sent it the long room.
        conn.execute("INSERT INTO models (id, connection_id, model, name, is_default, context_own,"
                     " reply_cap_mode, reasons, created_at, updated_at)"
                     " VALUES ('m1', 's1', 'brume', 'Brume', 1, 16384, 'auto', 0, ?, ?)", (at, at))
        conn.execute("INSERT INTO characters (id, name, created_at, updated_at)"
                     " VALUES ('serana', 'Serana', ?, ?)", (at, at))
        conn.execute("INSERT INTO conversations (id, character_id, model_id, created_at,"
                     " updated_at) VALUES ('x1', 'serana', 'm1', ?, ?)", (at, at))
        conn.commit()
    finally:
        conn.close()
    before_ways()

    from app.main import create_app

    app = create_app()
    await db.init_db()  # the update
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://localhost") as client:
        await no_memory_pass(client)
        assert (await client.get("/api/conversations/x1")).json()["play_style"] == "mine"
        body = await turn(client, "x1", model)

    assert body["max_tokens"] == 2048
    assert LONG in body["messages"][0]["content"]
