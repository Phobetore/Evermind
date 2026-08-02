"""Wave 3 tests: lorebooks, branches, memory maintenance, starter library."""

import json

import pytest

from app.cards.codec import card_to_lore_entries, character_to_card
from app.prompting.engine import match_lore
from app.providers.base import ProviderEvent

from .test_chat import FakeProvider, send, setup_conversation


@pytest.fixture()
def fake_provider(monkeypatch):
    FakeProvider.script = [ProviderEvent(type="delta", text="Reply."), ProviderEvent(type="done")]
    FakeProvider.captured = {}
    monkeypatch.setattr("app.services.chat_service.get_provider", FakeProvider)
    monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
    return FakeProvider


def make_msg(text, position):
    return {"role": "user", "variants": [text], "active_index": 0, "position": position}


# ---------- lore matching (pure) ----------

def test_match_lore_case_and_enabled_and_window():
    entries = [
        {"keys": ["Kabukicho"], "content": "Le quartier rouge.", "enabled": True,
         "case_sensitive": False, "priority": 0},
        {"keys": ["yakuza"], "content": "Les clans.", "enabled": False,
         "case_sensitive": False, "priority": 0},
        {"keys": ["Oni"], "content": "Case sensitive.", "enabled": True,
         "case_sensitive": True, "priority": 0},
        {"keys": ["old"], "content": "Outside window.", "enabled": True,
         "case_sensitive": False, "priority": 0},
    ]
    messages = [make_msg("the word old is here", 0)] + [
        make_msg(f"turn {i}", i) for i in range(1, 7)
    ] + [make_msg("We're going to KABUKICHO tonight, no yakuza, and oni in lowercase", 7)]
    matched = match_lore(entries, messages)
    contents = [e["content"] for e in matched]
    assert "Le quartier rouge." in contents          # case-insensitive match
    assert "Les clans." not in contents              # disabled
    assert "Case sensitive." not in contents    # case mismatch
    assert "Outside window." not in contents           # outside scan window


def test_match_lore_priority_and_budget():
    big = "mot " * 700  # ~800 tokens each
    entries = [
        {"keys": ["key"], "content": big, "enabled": True, "case_sensitive": False, "priority": 1},
        {"keys": ["key"], "content": "Small but higher priority.", "enabled": True,
         "case_sensitive": False, "priority": 10},
    ]
    matched = match_lore(entries, [make_msg("the key is here", 0)])
    assert matched[0]["content"] == "Small but higher priority."
    assert len(matched) == 1  # the big one no longer fits the budget


# ---------- codec character_book ----------

def test_character_book_round_trip():
    lore = [{"keys": ["crypt"], "content": "A sealed place.", "enabled": True,
             "case_sensitive": False, "priority": 3}]
    card = character_to_card({"name": "X", "kind": "character"}, lore_entries=lore)
    assert card["data"]["character_book"]["entries"][0]["insertion_order"] == 3
    back = card_to_lore_entries(card)
    assert back == lore


# ---------- lore API + injection ----------

async def test_lore_crud_and_injection(client, fake_provider):
    convo = await setup_conversation(client)
    char_id = convo["character_id"]
    entry = (await client.post(f"/api/characters/{char_id}/lore", json={
        "keys": ["crypt", "seal"], "content": "The crypt is protected by a blood seal.",
    })).json()
    assert entry["keys"] == ["crypt", "seal"]

    await send(client, convo["id"], content="Tell me about the crypt.")
    system = fake_provider.captured["payload"].system
    assert "WORLD KNOWLEDGE" in system
    assert "blood seal" in system

    await send(client, convo["id"], content="Let's change the subject entirely." * 10)
    # keyword still in scan window (previous turns), so it stays; disable it
    await client.patch(f"/api/lore/{entry['id']}", json={"enabled": False})
    await send(client, convo["id"], content="Encore something else.")
    assert "blood seal" not in fake_provider.captured["payload"].system

    deleted = await client.delete(f"/api/lore/{entry['id']}")
    assert deleted.status_code == 204


async def test_export_includes_book_import_restores_it(client, fake_provider):
    convo = await setup_conversation(client)
    char_id = convo["character_id"]
    await client.post(f"/api/characters/{char_id}/lore", json={
        "keys": ["clan"], "content": "The Shadow clan rules.",
    })
    card = (await client.get(f"/api/characters/{char_id}/export?format=json")).json()
    assert card["data"]["character_book"]["entries"][0]["keys"] == ["clan"]

    files = {"file": ("copy.json", json.dumps(card).encode(), "application/json")}
    imported = (await client.post("/api/characters/import", files=files)).json()
    lore = (await client.get(f"/api/characters/{imported['id']}/lore")).json()
    assert lore[0]["content"] == "The Shadow clan rules."


# ---------- branches ----------

async def test_branch_copies_up_to_message_and_filters_memories(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="First turn.")
    await send(client, convo["id"], content="Second turn.")
    messages = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    assert len(messages) == 5  # greeting + 2x(user+assistant)
    fork_at = messages[2]  # first assistant reply (position 2)

    # one memory before the fork, one after
    await client.post(f"/api/conversations/{convo['id']}/memories", json={"content": "Avant le fork."})
    early = (await client.get(f"/api/conversations/{convo['id']}/memories")).json()[0]
    assert early["source_position"] == 0
    # simulate a later auto fact
    from app.db import _connect
    db = await _connect()
    await db.execute("UPDATE memories SET source_position = 4 WHERE content = 'Avant le fork.'")
    await db.commit()
    await db.close()

    branch = (await client.post(f"/api/messages/{fork_at['id']}/branch")).json()
    assert branch["forked_from"] == convo["id"]
    assert branch["forked_at_position"] == 2
    assert len(branch["messages"]) == 3
    assert branch["messages"][-1]["content"] == fork_at["content"]
    branch_memories = (await client.get(f"/api/conversations/{branch['id']}/memories")).json()
    assert branch_memories == []  # source_position 4 > fork position 2

    # original untouched
    original = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert len(original["messages"]) == 5


# ---------- memory maintenance v2 ----------

async def test_memory_updates_and_obsoletes_respect_pins(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    await client.post(f"/api/conversations/{convo['id']}/memories", json={
        "content": "Sacred pinned fact.", "is_pinned": True})
    await client.post(f"/api/conversations/{convo['id']}/memories", json={
        "content": "Serana distrusts Aymeric."})
    # unpin the second (added as user+pinned=False by default) — it's not pinned already
    maintenance = json.dumps({
        "facts": [],
        "updated_facts": [
            {"replaces": "Serana distrusts Aymeric.", "content": "Serana trusts Aymeric."},
            {"replaces": "Sacred pinned fact.", "content": "OVERWRITE ATTEMPT."},
            {"replaces": "Inexistant.", "content": "Fact added for want of a target."},
        ],
        "obsolete_facts": ["Sacred pinned fact."],
        "summary": "Updated summary.",
    })
    fake_provider.script = [ProviderEvent(type="delta", text=maintenance), ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.status_code == 200
    contents = {m["content"] for m in
                (await client.get(f"/api/conversations/{convo['id']}/memories")).json()}
    assert "Serana trusts Aymeric." in contents   # updated
    assert "Serana distrusts Aymeric." not in contents
    assert "Sacred pinned fact." in contents                # pinned survives update AND delete
    assert "OVERWRITE ATTEMPT." not in contents
    assert "Fact added for want of a target." in contents        # fallback add


# ---------- starter library ----------

async def test_library_list_and_install(client, tmp_path, monkeypatch, fake_provider):
    card = {
        "spec": "chara_card_v2", "spec_version": "2.0",
        "data": {"name": "Demo card", "first_mes": "Hello {{user}}.",
                 "tags": ["demo"],
                 "character_book": {"entries": [{"keys": ["demo"], "content": "An entry."}]},
                 "extensions": {"evermind": {"kind": "scenario", "tagline": "Demo."}}},
    }
    lib = tmp_path / "lib"
    lib.mkdir()
    (lib / "fiche-demo.json").write_text(json.dumps(card), encoding="utf-8")
    from .test_cards import make_minimal_png
    (lib / "fiche-demo.png").write_bytes(make_minimal_png())
    monkeypatch.setenv("EVERMIND_LIBRARY_DIR", str(lib))

    listed = (await client.get("/api/library")).json()
    assert listed[0]["name"] == "Demo card"
    assert listed[0]["has_avatar"] is True
    avatar_resp = await client.get("/api/library/fiche-demo.json/avatar")
    assert avatar_resp.status_code == 200
    assert listed[0]["kind"] == "scenario"
    assert listed[0]["has_lorebook"] is True
    assert listed[0]["installed"] is False

    installed = await client.post("/api/library/fiche-demo.json/install")
    assert installed.status_code == 201
    char = installed.json()
    lore = (await client.get(f"/api/characters/{char['id']}/lore")).json()
    assert lore[0]["keys"] == ["demo"]
    assert char["avatar_url"], "install should copy the library illustration as avatar"
    media = await client.get(char["avatar_url"])
    assert media.status_code == 200
    assert media.content.startswith(bytes([0x89]) + b"PNG")

    listed = (await client.get("/api/library")).json()
    assert listed[0]["installed"] is True
    dupe = await client.post("/api/library/fiche-demo.json/install")
    assert dupe.status_code == 400
    traversal = await client.post("/api/library/..%2Fevil.json/install")
    assert traversal.status_code in (400, 404)


# ---------- message embeddings (phase 2 storage layer) ----------

async def test_message_embedding_stored_and_excluded(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import conversations as convo_repo

    async def fake_embed(texts, kind):
        return [[0.5, 0.5]]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    convo = await setup_conversation(client)
    msgs = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    assert "embedding" not in msgs[0]  # bytes never leak into API

    db = await _connect()
    try:
        mid = msgs[0]["id"]
        await convo_repo.set_message_embedding(db, mid, embeddings.pack([0.1, 0.2]))
        emb = await convo_repo.list_message_embeddings(db, convo["id"])
        assert mid in emb and isinstance(emb[mid], (bytes, memoryview))
    finally:
        await db.close()


async def test_update_message_invalidates_embedding(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import conversations as convo_repo

    convo = await setup_conversation(client)
    msgs = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    mid = msgs[0]["id"]
    db = await _connect()
    try:
        await convo_repo.set_message_embedding(db, mid, embeddings.pack([0.1, 0.2]))
        assert mid in await convo_repo.list_message_embeddings(db, convo["id"])
        # a swipe / active_index change must drop the now-stale vector
        await convo_repo.update_message(db, mid, active_index=0)
        assert mid not in await convo_repo.list_message_embeddings(db, convo["id"])
    finally:
        await db.close()


async def test_list_messages_missing_embeddings(client, fake_provider):
    from app.db import _connect
    from app.repositories import conversations as convo_repo

    await setup_conversation(client)
    db = await _connect()
    try:
        missing = await convo_repo.list_messages_missing_embeddings(db)
        assert missing and "variants" in missing[0] and "active_index" in missing[0]
    finally:
        await db.close()
