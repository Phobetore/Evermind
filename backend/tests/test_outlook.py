"""What the page reads to count: a turn built ahead for each AI and each way, without asking a
model or a vector, and the figures of an AI that the page counts with."""

import json

from app.prompting import embeddings, ways
from app.services import ai_call

from .helpers import add_model
from .test_memory_room import writing
from .test_my_ais_api import Model, conversation_on, model_of, open_db
from .test_ways_api import an_ai, copy_of, no_memory_pass, sql, story

AUTO = {"reply_cap": {"mode": "auto"}}


async def long_story(convo_id: str, count: int, length: int) -> None:
    """``count`` messages of ``length`` characters after what the conversation holds, by SQL."""
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
                (f"{convo_id}-{start + n}", convo_id, role,
                 json.dumps([f"Line {start + n}. " + "w" * length]), start + n))
        await conn.commit()
    finally:
        await conn.close()


async def outlook_of(client, convo_id: str, **params) -> dict:
    resp = await client.get(f"/api/conversations/{convo_id}/outlook", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def way_entry(outlook: dict, way_id: str) -> dict:
    return next(e for e in outlook["ways"] if e["play_style"] == way_id)


def no_passages(monkeypatch) -> None:
    monkeypatch.setattr(embeddings, "installed", lambda: False)


async def next_turn_context(client, convo_id: str, model: Model) -> dict:
    """What the next turn stores of what it read: the person's message, last, gets its reply."""
    sent = len(model.bodies)
    resp = await client.post("/api/chat", json={"conversation_id": convo_id,
                                                "mode": "regenerate"})
    assert resp.status_code == 200, resp.text
    from app.services import turns

    if running := await turns.running_for(convo_id):
        await running.finished.wait()
    assert len(model.bodies) == sent + 1
    messages = (await client.get(f"/api/conversations/{convo_id}")).json()["messages"]
    return messages[-1]["meta"]["context"]


async def test_the_outlook_is_the_turn_s_dry_run(client, monkeypatch):
    no_passages(monkeypatch)
    await no_memory_pass(client)
    ai = await an_ai(client)
    convo = await conversation_on(client, ai["id"])
    await story(convo["id"], 39)  # 40 messages, the person's last: it waits for its reply

    current = (await outlook_of(client, convo["id"], only="current"))["current"]

    model = Model(writing("*She nods.*")).serve(monkeypatch)
    context = await next_turn_context(client, convo["id"], model)
    assert current["messages_total"] == 40
    assert current["messages_included"] == context["messages_included"] == 24
    assert current["budget"] == context["budget"]
    assert current["used_tokens"] == context["used_tokens"]
    assert current["model_id"] == ai["id"] and current["play_style"] == "balanced"


async def test_the_dry_run_holds_with_every_reminder_and_a_story_cut_by_the_budget(
        client, monkeypatch):
    no_passages(monkeypatch)
    await no_memory_pass(client)
    resp = await client.put("/api/settings", json={"global_instructions": "Always in English."})
    assert resp.status_code == 200, resp.text
    await client.post("/api/personas", json={"name": "Alex", "description": "A tired courier."})
    ai = await an_ai(client, context_own=4096)
    convo = await conversation_on(client, ai["id"])
    resp = await client.put(f"/api/characters/{convo['character_id']}", json={"lore_entries": [
        {"keys": ["line 37"], "content": "The bell of the keep rings at noon."}]})
    assert resp.status_code == 200, resp.text
    for n in range(4):
        resp = await client.post(f"/api/conversations/{convo['id']}/memories",
                                 json={"content": f"Serana owes Alex boot number {n}."})
        assert resp.status_code in (200, 201), resp.text
    await long_story(convo["id"], 39, 300)  # the person's last: it waits for its reply

    current = (await outlook_of(client, convo["id"], only="current"))["current"]

    model = Model(writing("*She nods.*")).serve(monkeypatch)
    context = await next_turn_context(client, convo["id"], model)
    assert context["lore_matched"] > 0
    assert current["messages_included"] == context["messages_included"] < 24
    assert current["history_limit"] == 24  # cut by the budget, not by the way
    assert current["budget"] == context["budget"]
    assert current["used_tokens"] == context["used_tokens"]
    assert current["parts"] == context["parts"]
    assert current["parts"]["reminders"] > 0


async def test_it_asks_no_model_and_no_vector(client, monkeypatch):
    monkeypatch.setattr(embeddings, "installed", lambda: True)
    asked = []

    async def embed(texts, kind):
        asked.append(kind)

    monkeypatch.setattr(embeddings, "embed", embed)
    ai = await an_ai(client)
    convo = await conversation_on(client, ai["id"], play_style="immersive")
    await story(convo["id"], 200)
    model = Model(writing("*She nods.*")).serve(monkeypatch)

    outlook = await outlook_of(client, convo["id"])

    assert outlook["current"]["messages_included"] < outlook["current"]["messages_total"]
    assert model.bodies == [] and model.calls == []
    assert asked == []


async def test_a_model_too_small_says_how_many_it_rereads_and_what_light_would(client):
    ai = await an_ai(client, context_own=8192, **AUTO)
    convo = await conversation_on(client, ai["id"], play_style="immersive")
    await long_story(convo["id"], 200, 2000)

    outlook = await outlook_of(client, convo["id"])

    current = outlook["current"]
    assert current["history_limit"] == 60
    assert current["context_size"] == 8192
    assert current["messages_included"] < 60
    assert way_entry(outlook, "light")["messages_included"] > current["messages_included"]


async def test_every_ai_with_the_conversation_s_way_and_every_way_with_its_ai(client):
    ais = [await an_ai(client, model=f"model-{n}") for n in range(3)]
    await copy_of(client)
    convo = await conversation_on(client, ais[1]["id"], play_style="light")
    await story(convo["id"], 10)

    outlook = await outlook_of(client, convo["id"])

    assert [e["model_id"] for e in outlook["models"]] == [a["id"] for a in ais]
    assert {e["play_style"] for e in outlook["models"]} == {"light"}
    assert len(outlook["ways"]) == 5
    assert {e["model_id"] for e in outlook["ways"]} == {ais[1]["id"]}
    assert [e["play_style"] for e in outlook["ways"]][:4] == list(ways.BUILT_IN)
    assert [e["way"]["id"] for e in outlook["ways"]] == [e["play_style"] for e in outlook["ways"]]
    assert "conversations" not in outlook["ways"][0]["way"]
    assert outlook["current"]["way"]["id"] == "light"
    assert outlook["current"]["way"]["adjusted"] is False
    assert outlook["current"]["model_id"] == ais[1]["id"]

    only = await outlook_of(client, convo["id"], only="current")
    assert only["models"] == [] and only["ways"] == []
    assert only["current"] == outlook["current"]


async def test_the_current_way_carries_its_adjustments(client):
    ai = await an_ai(client)
    convo = await conversation_on(client, ai["id"])
    resp = await client.patch(f"/api/conversations/{convo['id']}",
                              json={"play_overrides": {"history_limit": 10}})
    assert resp.status_code == 200, resp.text

    current = (await outlook_of(client, convo["id"], only="current"))["current"]

    assert current["way"]["adjusted"] is True
    assert current["way"]["history_limit"] == current["history_limit"] == 10
    # Every other AI is counted under the way this conversation plays, adjustments and all.
    await an_ai(client, model="model-2")
    every = (await outlook_of(client, convo["id"]))["models"]
    assert len(every) == 2
    assert [e["history_limit"] for e in every] == [10, 10]


async def test_a_fixed_ceiling_under_the_way_s_room_is_said(client):
    ai = await an_ai(client, reply_cap={"mode": "fixed", "tokens": 600})
    convo = await conversation_on(client, ai["id"], play_style="immersive")

    outlook = await outlook_of(client, convo["id"])

    assert outlook["current"]["cap_short"] == 600
    assert outlook["current"]["reply_room"] == 2048
    assert way_entry(outlook, "light")["cap_short"] is None


async def test_a_way_that_leaves_the_room_to_the_ai_counts_the_room_the_turn_keeps(
        client, monkeypatch):
    no_passages(monkeypatch)
    await no_memory_pass(client)
    mine = await copy_of(client)
    resp = await client.put(f"/api/ways/{mine['id']}", json={"reply_room": None})
    assert resp.status_code == 200, resp.text
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    kept = {}
    for name, cap in (("auto", {"mode": "auto"}), ("fixed", {"mode": "fixed", "tokens": 600}),
                      ("unsent", {"mode": "unsent"})):
        ai = await an_ai(client, model=f"model-{name}", reply_cap=cap)
        convo = await conversation_on(client, ai["id"], play_style=mine["id"])
        await story(convo["id"], 9)  # the person's last: it waits for its reply

        current = (await outlook_of(client, convo["id"], only="current"))["current"]
        context = await next_turn_context(client, convo["id"], model)

        assert current["reply_room"] == context["reply_room"], name
        assert current["cap_short"] is None, name
        kept[name] = current["reply_room"]
    assert kept == {"auto": 4096, "fixed": 600, "unsent": 1024}


async def test_what_is_kept_for_the_reply_is_what_the_next_turn_keeps(client, monkeypatch):
    no_passages(monkeypatch)
    await no_memory_pass(client)
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    found = {}
    for name, fields, way in (
            ("reasons", {"read": {"reasons": True}, "reply_cap": {"mode": "auto"}}, "balanced"),
            ("unsent", {"reply_cap": {"mode": "unsent"}}, "light"),
            ("fixed", {"reply_cap": {"mode": "fixed", "tokens": 300}}, "balanced")):
        ai = await an_ai(client, model=f"model-{name}", **fields)
        convo = await conversation_on(client, ai["id"], play_style=way)
        await story(convo["id"], 9)  # the person's last: it waits for its reply

        outlook = await outlook_of(client, convo["id"])
        context = await next_turn_context(client, convo["id"], model)

        current = outlook["current"]
        assert current["reply_kept"] == context["reply_room"], name
        # Every entry says it, for its own AI and its own way.
        assert next(e for e in outlook["models"] if e["model_id"] == ai["id"])["reply_kept"] == (
            context["reply_room"]), name
        assert way_entry(outlook, way)["reply_kept"] == context["reply_room"], name
        found[name] = (current["reply_room"], current["reply_kept"])
    # The way's room stays what the way asks.
    assert found == {"reasons": (1024, 4096), "unsent": (512, 1024), "fixed": (1024, 300)}


async def test_passages_are_counted_at_their_budget(client, monkeypatch):
    async def embed(texts, kind):
        return None

    monkeypatch.setattr(embeddings, "embed", embed)
    ai = await an_ai(client)
    convo = await conversation_on(client, ai["id"])
    await story(convo["id"], 200)

    monkeypatch.setattr(embeddings, "installed", lambda: True)
    found = await outlook_of(client, convo["id"])
    immersive, light = way_entry(found, "immersive"), way_entry(found, "light")
    budget = ways.passage_budget({k: ways.BUILT_IN["immersive"][k] for k in ways.REMINDER_FIELDS},
                                 immersive["budget"])
    assert budget > 0
    assert immersive["parts"]["reminders"] - light["parts"]["reminders"] >= budget

    # A story read whole looks for no passage: none is counted.
    fits = await conversation_on(client, ai["id"])
    await story(fits["id"], 9)
    whole = way_entry(await outlook_of(client, fits["id"]), "immersive")
    assert whole["messages_included"] == whole["messages_total"]

    no_passages(monkeypatch)
    found = await outlook_of(client, convo["id"])
    immersive, light = way_entry(found, "immersive"), way_entry(found, "light")
    assert immersive["parts"]["reminders"] - light["parts"]["reminders"] < budget
    assert way_entry(await outlook_of(client, fits["id"]), "immersive")["parts"] == whole["parts"]


async def test_the_counts_are_the_server_s_once_measured(client):
    ai = await an_ai(client)
    convo = await conversation_on(client, ai["id"])
    await story(convo["id"], 9)  # a story that fits: the ratio changes no message read
    before = (await outlook_of(client, convo["id"], only="current"))["current"]

    await sql("UPDATE models SET token_ratio = 1.25, token_ratio_n = 1 WHERE id = ?", (ai["id"],))
    after = (await outlook_of(client, convo["id"], only="current"))["current"]

    assert after["messages_included"] == before["messages_included"] == 10
    assert after["used_tokens"] == round(before["used_tokens"] * 1.25)
    assert after["parts"]["history"] == round(before["parts"]["history"] * 1.25)
    assert after["context_size"] == before["context_size"]


async def test_with_no_ai_the_outlook_still_counts_messages(client):
    character = (await client.post("/api/characters", json={"name": "Serana"})).json()
    resp = await client.post("/api/conversations", json={"character_id": character["id"]})
    assert resp.status_code == 201, resp.text
    convo = resp.json()
    await story(convo["id"], 30)

    outlook = await outlook_of(client, convo["id"])

    current = outlook["current"]
    assert current["model_id"] is None
    assert current["context_size"] == ai_call.ASSUMED_WINDOW == 16384
    assert current["messages_total"] == 30
    assert current["messages_included"] == 24
    assert outlook["models"] == []
    # Every way is still counted, on the window assumed and the margin of an AI not yet measured.
    assert [e["play_style"] for e in outlook["ways"]] == list(ways.BUILT_IN)
    assert {e["model_id"] for e in outlook["ways"]} == {None}
    assert current["reply_room"] == ways.BUILT_IN["balanced"]["reply_room"] == 1024
    assert current["budget"] == (ai_call.ASSUMED_WINDOW - current["reply_room"]
                                 - max(200, int(16384 * 0.06)))
    # As an AI of that size that leaves its room to the way would count it.
    ai = await an_ai(client, context_own=16384, **AUTO)
    on_ai = await conversation_on(client, ai["id"])
    counted = (await outlook_of(client, on_ai["id"], only="current"))["current"]
    assert counted["budget"] == current["budget"]
    assert counted["reply_room"] == current["reply_room"]


async def test_a_way_written_by_hand_stops_neither_a_turn_nor_the_outlook(client, monkeypatch):
    no_passages(monkeypatch)
    await no_memory_pass(client)
    ai = await an_ai(client)
    convo = await conversation_on(client, ai["id"])
    await story(convo["id"], 39)
    # As a person may write them with sqlite: a count as text, an object, a length unknown.
    styles = {"overrides": {"light": {"history_limit": {"a": 1}}},
              "custom": [{"id": "mine", "name": None, "history_limit": "30",
                          "reply_length": "huge", "reply_room": "2048", "passage_cap": "800",
                          "facts_cap": [1], "lore_share": "0.1"}]}
    await sql("INSERT INTO settings (key, value) VALUES ('play_styles', ?) ON CONFLICT(key)"
              " DO UPDATE SET value = excluded.value", (json.dumps(styles),))
    await sql("UPDATE conversations SET play_style = 'mine' WHERE id = ?", (convo["id"],))

    outlook = await outlook_of(client, convo["id"])
    # Each field it cannot play plays balanced's figure.
    assert way_entry(outlook, "mine")["history_limit"] == 24
    assert way_entry(outlook, "light")["history_limit"] == 16
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    context = await next_turn_context(client, convo["id"], model)
    assert (context["history_limit"], context["messages_included"]) == (24, 24)
    assert context["reply_room"] == 1024


async def test_an_unknown_conversation_has_no_outlook(client):
    resp = await client.get("/api/conversations/gone/outlook")
    assert resp.status_code == 404
    assert resp.json()["resource"] == "conversation"


async def test_the_figures_the_page_counts_with(client):
    ai = await an_ai(client)
    fresh = await model_of(client, ai["id"])
    assert fresh["token_ratio"] is None
    assert fresh["reply_tokens"] == {"short": None, "medium": None, "long": None}
    assert fresh["thinking_allowance"] == ai_call.THINKING_ALLOWANCE
    assert fresh["thinking_measured"] is False
    assert fresh["usage_seen"] is None
    assert fresh["anthropic"] is False
    assert fresh["margin"] == max(200, int(16384 * 0.06))

    # A figure stored with nothing measured behind it is not shown as measured.
    unmeasured = {"short": {"avg": 120, "n": 0}, "thinking": {"avg": 900, "n": 0}}
    await sql("UPDATE models SET token_ratio = 1.3, token_ratio_n = 0, reply_tokens_avg = ?"
              " WHERE id = ?", (json.dumps(unmeasured), ai["id"]))
    unsure = await model_of(client, ai["id"])
    assert unsure["token_ratio"] is None
    assert unsure["reply_tokens"] == {"short": None, "medium": None, "long": None}
    assert unsure["thinking_measured"] is False

    averages = {"medium": {"avg": 301.6, "n": 3}, "thinking": {"avg": 812.4, "n": 2}}
    await sql("UPDATE models SET token_ratio = 1.1, token_ratio_n = 2, usage_seen = 1,"
              " reply_tokens_avg = ? WHERE id = ?", (json.dumps(averages), ai["id"]))
    measured = await model_of(client, ai["id"])

    assert measured["token_ratio"] == 1.1
    assert measured["reply_tokens"] == {"short": None, "medium": 302, "long": None}
    # Twice what its thinking took on average: what the reserve keeps for it.
    assert measured["thinking_allowance"] == 1625
    assert measured["thinking_measured"] is True
    assert measured["usage_seen"] is True
    assert measured["margin"] == max(200, int(16384 * 0.03))
    assert measured["service"]["family"]

    anthropic = await add_model(client, base_url="https://api.anthropic.com", provider="anthropic",
                                api_key="sk-test")
    assert (await model_of(client, anthropic["id"]))["anthropic"] is True


async def test_the_outlook_is_light(client):
    for n in range(10):
        await an_ai(client, model=f"model-{n}")
    await copy_of(client, name="Mine")
    await copy_of(client, "immersive", name="Long nights")
    convo = await conversation_on(client)
    await story(convo["id"], 60)

    async with client.stream("GET", f"/api/conversations/{convo['id']}/outlook",
                             headers={"Accept-Encoding": "gzip"}) as resp:
        assert resp.status_code == 200
        assert resp.headers.get("content-encoding") == "gzip"
        raw = b"".join([part async for part in resp.aiter_raw()])
    outlook = await outlook_of(client, convo["id"])

    assert len(outlook["models"]) == 10 and len(outlook["ways"]) == 6
    assert len(raw) < 2048


async def test_a_server_at_home_is_counted_at_its_own_size(client):
    # LM Studio's address: what it loads is counted, as the turn counts it.
    ai = await an_ai(client, context_own=None)
    convo = await conversation_on(client, ai["id"])

    current = (await outlook_of(client, convo["id"], only="current"))["current"]

    assert current["context_size"] == (await model_of(client, ai["id"]))["context"]["used"]
