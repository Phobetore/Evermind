"""API CRUD tests: characters (+lorebook/avatar), personas, connections,
conversations (+greeting seeding), settings."""

import pytest

from app.providers.base import ProviderEvent

from .conftest import PNG, SAMPLING, FakeProvider, send


async def create_character(client, **overrides):
    payload = {"name": "Serana", "greeting": "*She stirs.* Hello {{user}}.", **overrides}
    resp = await client.post("/api/characters", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------- characters ----------

async def test_character_crud(client):
    a = await create_character(client, tags=["fantasy"], kind="character")
    await create_character(client, name="The Drowned City", kind="scenario", tags=["mystery"])

    listed = (await client.get("/api/characters")).json()
    assert {c["name"] for c in listed} == {"Serana", "The Drowned City"}

    updated = await client.put(f"/api/characters/{a['id']}", json={"tagline": "Vampire lady"})
    assert updated.status_code == 200
    assert updated.json()["tagline"] == "Vampire lady"
    assert updated.json()["name"] == "Serana"  # partial update keeps other fields

    deleted = await client.delete(f"/api/characters/{a['id']}")
    assert deleted.status_code == 204
    gone = await client.get(f"/api/characters/{a['id']}")
    assert gone.status_code == 404


async def test_a_card_is_made_read_and_saved_with_its_lorebook(client):
    long = "The tide comes in twice a day. " * 200  # an imported book has such entries
    made = await create_character(client, lore_entries=[
        {"keys": ["tide", " "], "content": long, "enabled": False},
        {"keys": [], "content": "No keyword."},
        {"keys": ["crypt"], "content": " It is shut. "},
        {"keys": ["nothing"], "content": "  "},
        {"keys": ["bell"], "content": "It rings at noon."},
    ])
    url = f"/api/characters/{made['id']}"

    async def lore():
        read = (await client.get(url)).json()
        return [(e["keys"], e["content"], e["enabled"]) for e in read["lore_entries"]]

    assert await lore() == [
        (["tide"], long.strip(), False), (["crypt"], "It is shut.", True),
        (["bell"], "It rings at noon.", True)]

    await client.put(url, json={"tagline": "Lore left as it is"})
    assert len(await lore()) == 3

    # Emptying a box and saving is how an entry is taken out.
    await client.put(url, json={"lore_entries": [
        {"keys": ["bell"], "content": "It rings at dusk."}, {"keys": ["crypt"], "content": ""}]})
    assert await lore() == [(["bell"], "It rings at dusk.", True)]


async def test_avatar_upload(client):
    created = await create_character(client)
    files = {"file": ("a.png", PNG, "image/png")}
    resp = await client.post(f"/api/characters/{created['id']}/avatar", files=files)
    assert resp.status_code == 200
    assert resp.json()["avatar_url"]


# ---------- personas ----------

async def test_persona_crud_and_default(client):
    p1 = (await client.post("/api/personas", json={"name": "Alex"})).json()
    assert p1["is_default"] is True  # first persona becomes default
    p2 = (await client.post("/api/personas", json={"name": "Morgan", "is_default": True})).json()
    assert p2["is_default"] is True
    listed = (await client.get("/api/personas")).json()
    defaults = [p for p in listed if p["is_default"]]
    assert [p["name"] for p in defaults] == ["Morgan"]  # single default enforced
    deleted = await client.delete(f"/api/personas/{p1['id']}")
    assert deleted.status_code == 204


# ---------- connections ----------

async def test_connection_key_masking_and_update(client):
    resp = await client.post("/api/connections", json={
        "name": "OpenRouter",
        "provider": "openai-compatible",
        "base_url": "https://openrouter.ai/api/v1",
        "api_key": "sk-or-v1-secret1234",
        "model": "meta-llama/llama-3-70b",
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert "api_key" not in body
    assert body["api_key_set"] is True
    assert body["api_key_hint"].endswith("1234")
    assert body["is_default"] is True  # first connection becomes default

    # a PUT is the whole connection: what it leaves out is emptied, but for the key
    url = f"/api/connections/{body['id']}"
    upd = (await client.put(url, json={"name": "OR", "base_url": body["base_url"]})).json()
    assert (upd["name"], upd["model"], upd["api_key_set"]) == ("OR", "", True)
    # explicit empty string clears it
    upd = (await client.put(url, json={**upd, "api_key": ""})).json()
    assert upd["api_key_set"] is False


# A model that thinks first spends a small ceiling before it writes a word.
@pytest.mark.parametrize("ceiling", [4096, None])
async def test_the_speed_test_keeps_the_connections_own_ceiling(client, monkeypatch, ceiling):
    monkeypatch.setattr(FakeProvider, "script", [ProviderEvent(type="delta", text="Rain."),
                                                 ProviderEvent(type="done")], raising=False)
    monkeypatch.setattr(FakeProvider, "captured", {})
    monkeypatch.setattr("app.routers.connections.get_provider", FakeProvider)
    created = (await client.post("/api/connections", json={
        "name": "Local", "base_url": "http://localhost:1234/v1", "max_tokens": ceiling,
    })).json()
    assert (await client.post("/api/connections/benchmark", json=created)).json()["ok"]
    assert FakeProvider.captured["connection"]["max_tokens"] == ceiling


async def make_connection(client, name):
    resp = await client.post("/api/connections", json={
        "name": name, "base_url": "http://localhost:1234/v1", "model": "m"})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def tagged_and_used(client, monkeypatch, **conversation) -> tuple[list[str], str]:
    """The connections the list tags as the default, and the one a new conversation talks to."""
    monkeypatch.setattr(FakeProvider, "script", [ProviderEvent(type="delta", text="Hi."),
                                                 ProviderEvent(type="done")], raising=False)
    monkeypatch.setattr(FakeProvider, "captured", {})
    monkeypatch.setattr("app.services.chat_service.get_provider", FakeProvider)
    tagged = [c["name"] for c in (await client.get("/api/connections")).json() if c["is_default"]]
    char = await create_character(client)
    convo = (await client.post("/api/conversations",
                               json={"character_id": char["id"], **conversation})).json()
    await send(client, convo["id"], content="Hello")
    return tagged, FakeProvider.captured["connection"]["name"]


async def test_the_connection_tagged_default_is_the_one_used(client, monkeypatch):
    first = await make_connection(client, "First")
    second = await make_connection(client, "Second")
    # What the list in Settings wrote, which a conversation followed while the tag said otherwise.
    await client.put("/api/settings", json={"default_connection_id": first["id"]})
    await client.put(f"/api/connections/{second['id']}", json={**second, "is_default": True})

    assert await tagged_and_used(client, monkeypatch) == (["Second"], "Second")
    assert await tagged_and_used(client, monkeypatch, connection_id=first["id"]) == (
        ["Second"], "First")


async def test_with_none_marked_the_oldest_connection_is_tagged_and_used(client, monkeypatch):
    first = await make_connection(client, "First")
    await make_connection(client, "Second")
    await client.put(f"/api/connections/{first['id']}", json={**first, "is_default": False})

    assert await tagged_and_used(client, monkeypatch) == (["First"], "First")


async def test_connection_test_endpoint_unreachable(client):
    created = (await client.post("/api/connections", json={
        "name": "Dead", "provider": "openai-compatible",
        "base_url": "http://127.0.0.1:1", "model": "x",
    })).json()
    resp = await client.post("/api/connections/test", json=created)
    assert (resp.status_code, resp.json()["kind"]) == (502, "unreachable")


# ---------- conversations ----------

async def test_conversation_created_with_greeting_variants(client):
    char = await create_character(client, alternate_greetings=["Alt greeting"])
    persona = (await client.post("/api/personas", json={"name": "Alex"})).json()
    resp = await client.post("/api/conversations", json={
        "character_id": char["id"], "persona_id": persona["id"],
    })
    assert resp.status_code == 201, resp.text
    convo = resp.json()
    messages = convo["messages"]
    assert len(messages) == 1
    first = messages[0]
    assert first["role"] == "assistant"
    assert first["content"] == "*She stirs.* Hello Alex."  # macros resolved with persona name
    assert len(first["variants"]) == 2  # greeting + alternate


async def test_conversation_list_patch_delete(client):
    char = await create_character(client)
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    listed = (await client.get("/api/conversations")).json()
    assert len(listed) == 1
    assert listed[0]["character"]["name"] == "Serana"

    patched = await client.patch(f"/api/conversations/{convo['id']}", json={"title": "Crypt run"})
    assert patched.json()["title"] == "Crypt run"

    deleted = await client.delete(f"/api/conversations/{convo['id']}")
    assert deleted.status_code == 204
    gone = await client.get(f"/api/conversations/{convo['id']}")
    assert gone.status_code == 404


async def test_a_patch_leaves_the_persona_alone(client):
    """No screen changes it there, and an id gone stale made the whole patch fail."""
    char = await create_character(client)
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()

    resp = await client.patch(f"/api/conversations/{convo['id']}",
                              json={"persona_id": "gone", "title": "Crypt run"})

    assert resp.status_code == 200, resp.text
    assert (resp.json()["persona_id"], resp.json()["title"]) == (convo["persona_id"], "Crypt run")


async def test_conversation_without_greeting_has_no_messages(client):
    char = await create_character(client, greeting="")
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    assert convo["messages"] == []


# ---------- settings ----------

async def test_settings_roundtrip(client):
    initial = (await client.get("/api/settings")).json()
    assert initial["global_instructions"] == ""
    resp = await client.put("/api/settings", json={"global_instructions": "Always in English."})
    assert resp.status_code == 200
    assert (await client.get("/api/settings")).json()["global_instructions"] == "Always in English."


async def test_a_generation_setting_left_empty_is_stored_empty(client):
    """Empty is how a connection leaves a setting to the model."""
    created = (await client.post("/api/connections", json={
        "name": "Bare", "provider": "openai-compatible",
        "base_url": "https://api.openai.com/v1", "model": "x",
    })).json()
    assert created["context_size"] == 16384
    assert [created[k] for k in SAMPLING] == [None] * 5
    assert "extra_params" not in created

    url = f"/api/connections/{created['id']}"
    filled = (await client.put(url, json={**created, "temperature": 0, "max_tokens": 512})).json()
    assert (filled["temperature"], filled["max_tokens"]) == (0, 512)
    emptied = (await client.put(url, json={**filled, "temperature": None})).json()
    assert (emptied["temperature"], emptied["max_tokens"]) == (None, 512)


async def test_favorites_toggle_and_sort(client):
    plain = await create_character(client, name="Ordinaire")
    fav = await create_character(client, name="Beloved")
    assert fav["is_favorite"] is False

    updated = (await client.put(f"/api/characters/{fav['id']}", json={"is_favorite": True})).json()
    assert updated["is_favorite"] is True
    assert updated["name"] == "Beloved"  # partial update untouched

    everyone = (await client.get("/api/characters")).json()
    assert everyone[0]["id"] == fav["id"]  # favorites sort first
    assert {c["id"] for c in everyone} == {fav["id"], plain["id"]}


async def test_a_favourite_is_no_edit_and_leaves_the_card_in_its_place(client):
    cards = [await create_character(client, name=name) for name in ("Old", "Middle", "New")]
    from app.db import _connect
    db = await _connect()
    for day, card in enumerate(cards, start=1):
        await db.execute("UPDATE characters SET updated_at = ? WHERE id = ?",
                         (f"2026-01-0{day}", card["id"]))
    await db.commit()
    await db.close()
    url = f"/api/characters/{cards[0]['id']}"

    starred = (await client.put(url, json={"is_favorite": True})).json()
    await client.put(url, json={"is_favorite": False})

    assert starred["updated_at"] == "2026-01-01"
    assert [c["name"] for c in (await client.get("/api/characters")).json()] == [
        "New", "Middle", "Old"]


async def test_a_conversation_asked_for_on_a_deleted_connection_starts_without_one(client):
    """A listing older than the deletion must not fail the start on the foreign key."""
    conn = await make_connection(client, "Jetable")
    deleted = await client.delete(f"/api/connections/{conn['id']}")
    assert deleted.status_code == 204

    char = await create_character(client)
    resp = await client.post("/api/conversations",
                             json={"character_id": char["id"], "connection_id": conn["id"]})
    assert resp.status_code == 201, resp.text
    assert resp.json()["connection_id"] is None


async def test_deleting_default_persona_does_not_break_conversations(client):
    persona = (await client.post("/api/personas", json={"name": "Jetable"})).json()
    assert persona["is_default"] is True
    deleted = await client.delete(f"/api/personas/{persona['id']}")
    assert deleted.status_code == 204

    assert (await client.get("/api/personas")).json() == []

    char = await create_character(client)
    resp = await client.post("/api/conversations", json={"character_id": char["id"]})
    assert resp.status_code == 201, resp.text
    assert resp.json()["persona_id"] is None
