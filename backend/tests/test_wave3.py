"""Wave 3 tests: lorebooks, branches, memory maintenance, starter library."""

import json

import pytest

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
        {"keys": ["Kabukicho"], "content": "Le quartier rouge.", "enabled": True},
        {"keys": ["yakuza"], "content": "Les clans.", "enabled": False},
        {"keys": ["Oni"], "content": "Any case.", "enabled": True},
        {"keys": ["old"], "content": "Outside window.", "enabled": True},
    ]
    messages = [make_msg("the word old is here", 0)] + [
        make_msg(f"turn {i}", i) for i in range(1, 7)
    ] + [make_msg("We're going to KABUKICHO tonight, no yakuza, and oni in lowercase", 7)]
    matched = match_lore(entries, messages)
    contents = [e["content"] for e in matched]
    assert "Le quartier rouge." in contents          # case-insensitive match
    assert "Les clans." not in contents              # disabled
    assert "Any case." in contents
    assert "Outside window." not in contents           # outside scan window


def test_match_lore_order_and_budget():
    big = "mot " * 525  # 601 tokens of the 800
    entries = [{"keys": ["key"], "content": content} for content in (big, big + "again", "Small.")]
    matched = match_lore(entries, [make_msg("the key is here", 0)])
    # The first in the lorebook has the room; one that does not fit leaves it to the next.
    assert [e["content"] for e in matched] == [big, "Small."]


# ---------- lore injection ----------

async def test_lore_reaches_the_prompt_until_it_is_switched_off(client, fake_provider):
    convo = await setup_conversation(client)
    url = f"/api/characters/{convo['character_id']}"
    entry = {"keys": ["crypt", "seal"], "content": "The crypt is protected by a blood seal."}
    await client.put(url, json={"lore_entries": [entry]})

    await send(client, convo["id"], content="Tell me about the crypt.")
    system = fake_provider.captured["payload"].system
    assert "WORLD KNOWLEDGE" in system
    assert "blood seal" in system

    await send(client, convo["id"], content="Let's change the subject entirely." * 10)
    # keyword still in scan window (previous turns), so it stays; disable it
    await client.put(url, json={"lore_entries": [{**entry, "enabled": False}]})
    await send(client, convo["id"], content="Encore something else.")
    assert "blood seal" not in fake_provider.captured["payload"].system


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
    await db.execute("UPDATE memories SET source_position = 4, source = 'auto'"
                     " WHERE content = 'Avant le fork.'")
    await db.commit()
    await db.close()

    branch = (await client.post(f"/api/messages/{fork_at['id']}/branch")).json()
    assert branch["forked_from"] == convo["id"]
    assert len(branch["messages"]) == 3
    assert branch["messages"][-1]["content"] == fork_at["content"]
    branch_memories = (await client.get(f"/api/conversations/{branch['id']}/memories")).json()
    assert branch_memories == []  # source_position 4 > fork position 2

    # original untouched
    original = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert len(original["messages"]) == 5


@pytest.mark.parametrize("title", ["Crypt run", ""])
async def test_a_branch_keeps_the_title_of_its_story(client, title):
    """The list marks a branch, and says "Untitled" in the person's language."""
    convo = await setup_conversation(client)
    await client.patch(f"/api/conversations/{convo['id']}", json={"title": title})
    greeting = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"][0]

    branch = (await client.post(f"/api/messages/{greeting['id']}/branch")).json()

    assert branch["title"] == title


async def test_a_new_branch_comes_first_in_the_list(client):
    """Its messages keep the dates they were written on, but the branch itself is new."""
    story = await setup_conversation(client)
    later = (await client.post("/api/conversations",
                               json={"character_id": story["character_id"]})).json()
    from app.db import _connect
    db = await _connect()
    for convo_id, day in ((story["id"], "2026-01-01"), (later["id"], "2026-01-02")):
        await db.execute("UPDATE messages SET created_at = ? WHERE conversation_id = ?",
                         (day, convo_id))
        await db.execute("UPDATE conversations SET created_at = ?, updated_at = ? WHERE id = ?",
                         (day, day, convo_id))
    await db.commit()
    await db.close()
    greeting = (await client.get(f"/api/conversations/{story['id']}")).json()["messages"][0]

    branch = (await client.post(f"/api/messages/{greeting['id']}/branch")).json()

    listed = [c["id"] for c in (await client.get("/api/conversations")).json()]
    assert listed == [branch["id"], later["id"], story["id"]]


# ---------- memory maintenance v2 ----------

async def test_memory_updates_and_obsoletes_respect_pins(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    await client.post(f"/api/conversations/{convo['id']}/memories", json={
        "content": "Sacred pinned fact.", "is_pinned": True})
    await client.post(f"/api/conversations/{convo['id']}/memories", json={
        "content": "Serana distrusts Aymeric."})
    # Written by the model, not by hand: a correction leaves a person's own facts alone.
    from app.db import _connect
    db = await _connect()
    await db.execute("UPDATE memories SET source = 'auto' WHERE content = 'Serana distrusts Aymeric.'")
    await db.commit()
    await db.close()
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

async def test_the_library_lists_its_cards_and_serves_their_jpeg_portraits(client, tmp_path,
                                                                            monkeypatch):
    card = {"spec": "chara_card_v2", "spec_version": "2.0", "data": {"name": "Demo card"}}
    lib = tmp_path / "lib"
    lib.mkdir()
    for name in ("demo", "other"):
        (lib / f"{name}.json").write_text(json.dumps(card), encoding="utf-8")
    (lib / "demo.jpg").write_bytes(b"JPEG bytes")
    (lib / "other.png").write_bytes(b"PNG bytes")  # a portrait is a JPEG
    (lib / "broken.json").write_text("{", encoding="utf-8")
    monkeypatch.setenv("EVERMIND_LIBRARY_DIR", str(lib))

    assert (await client.get("/api/library")).json() == [
        {"filename": "demo.json", "card": card, "has_avatar": True},
        {"filename": "other.json", "card": card, "has_avatar": False},
    ]
    portrait = await client.get("/api/library/demo.json/avatar")
    assert (portrait.status_code, portrait.headers["content-type"]) == (200, "image/jpeg")
    assert portrait.content == b"JPEG bytes"
    assert (await client.get("/api/library/other.json/avatar")).status_code == 404


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
