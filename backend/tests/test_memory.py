"""Memory system tests: extraction, dedup, scheduling, injection, endpoints."""

import json

import pytest

from app.providers.base import ProviderEvent
from app.services import memory_service

from .test_chat import FakeProvider, send, setup_conversation

EXTRACTION_JSON = json.dumps({
    "facts": [
        {"content": "Aymeric broke the crypt seal.", "kind": "event"},
        {"content": "Serana distrusts Aymeric.", "kind": "relationship"},
    ],
    "summary": "Aymeric woke Serana by breaking the seal of her crypt.",
})


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


async def get_db_for_test(client):
    """Open a DB connection on the test's temp database."""
    from app.db import _connect

    return await _connect()


async def test_run_maintenance_stores_facts_and_summary(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])

    fake_provider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                            ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["facts_added"]) == 2
    assert body["summary"].startswith("Aymeric woke")

    memories = (await client.get(f"/api/conversations/{convo['id']}/memories")).json()
    assert {m["content"] for m in memories} == {
        "Aymeric broke the crypt seal.", "Serana distrusts Aymeric.",
    }
    # the extraction prompt received existing summary and turns
    payload = fake_provider.captured["payload"]
    assert "NEWEST TURNS" in payload.messages[0]["content"]
    assert "memory-keeper" in payload.system


async def test_second_extraction_dedups_and_advances(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    fake_provider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                            ProviderEvent(type="done")]
    await client.post(f"/api/conversations/{convo['id']}/memories/extract")

    # no new turns since memory_position advanced -> no LLM call, no dupes
    fake_provider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                            ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.json()["facts_added"] == []
    memories = (await client.get(f"/api/conversations/{convo['id']}/memories")).json()
    assert len(memories) == 2


async def test_extraction_tolerates_wrapped_json(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    fake_provider.script = [
        ProviderEvent(type="delta", text=f"Here is the memory:\n{EXTRACTION_JSON}\nThere."),
        ProviderEvent(type="done"),
    ]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.status_code == 200
    assert len(resp.json()["facts_added"]) == 2


async def test_extraction_error_returns_502(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    fake_provider.script = [ProviderEvent(type="delta", text="not json"),
                            ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.status_code == 502


async def test_is_due_after_threshold_and_setting(client, fake_provider):
    convo = await setup_conversation(client)
    # keep the auto background task from firing mid-test (its temp DB dies
    # with the test); re-enable to assert the threshold, disable to assert off
    await client.put("/api/settings", json={"auto_memory": False})
    db = await get_db_for_test(client)
    try:
        assert not await memory_service.is_due(db, convo["id"])
        for _ in range(memory_service.MAINTENANCE_EVERY):
            fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                                    ProviderEvent(type="done")]
            await send(client, convo["id"], content="encore")

        await client.put("/api/settings", json={"auto_memory": True})
        assert await memory_service.is_due(db, convo["id"])

        await client.put("/api/settings", json={"auto_memory": False})
        assert not await memory_service.is_due(db, convo["id"])
    finally:
        await db.close()


async def test_facts_injected_into_chat_payload(client, fake_provider):
    convo = await setup_conversation(client)
    await client.post(f"/api/conversations/{convo['id']}/memories", json={
        "content": "Aymeric killed Serana's parents before her eyes.",
        "kind": "event", "is_pinned": True,
    })
    await send(client, convo["id"])
    payload = fake_provider.captured["payload"]
    assert "### ESTABLISHED FACTS" in payload.system
    assert "killed Serana's parents" in payload.system


async def test_memory_crud(client, fake_provider):
    convo = await setup_conversation(client)
    created = (await client.post(f"/api/conversations/{convo['id']}/memories", json={
        "content": "Serana hates garlic.", "kind": "fact",
    })).json()
    assert created["source"] == "user"

    dupe = await client.post(f"/api/conversations/{convo['id']}/memories", json={
        "content": "Serana hates garlic.",
    })
    assert dupe.status_code == 400

    pinned = (await client.patch(f"/api/memories/{created['id']}", json={"is_pinned": True})).json()
    assert pinned["is_pinned"] is True

    deleted = await client.delete(f"/api/memories/{created['id']}")
    assert deleted.status_code == 204
    assert (await client.get(f"/api/conversations/{convo['id']}/memories")).json() == []


async def test_facts_budget_scales_with_context(client, fake_provider):
    """700-token budget was starving 16k-context chats; it now scales up."""
    from app.prompting.engine import build_chat_payload
    # 40 facts of ~30 tokens each ≈ 1200 tokens: over the old 700 floor,
    # under the scaled budget on a large context.
    memories = [{"content": "Fait " + "mot " * 25, "source_position": i, "is_pinned": False}
                for i in range(40)]
    # recent turn (100) so every fact's turn is outside the visible window
    recent = [{"role": "user", "variants": ["hi"], "active_index": 0, "position": 100}]
    small = build_chat_payload(
        character={"name": "X", "kind": "character"}, persona=None,
        conversation={"summary": ""}, messages=recent,
        connection={"context_size": 4096, "max_tokens": 512}, memories=memories,
    )
    big = build_chat_payload(
        character={"name": "X", "kind": "character"}, persona=None,
        conversation={"summary": ""}, messages=recent,
        connection={"context_size": 32768, "max_tokens": 1024}, memories=memories,
    )
    assert big.stats["facts_injected"] > small.stats["facts_injected"]
    assert big.stats["facts_total"] == 40


async def test_history_limit_setting_flows_into_chat(client, fake_provider):
    """PUT /api/settings history_limit must cap the turns the provider sees."""
    updated = (await client.put("/api/settings", json={"history_limit": 4})).json()
    assert updated["history_limit"] == 4

    convo = await setup_conversation(client)
    for _ in range(3):  # greeting + 3x(user+assistant) = 7 messages
        fake_provider.script = [ProviderEvent(type="delta", text="Reply."),
                                ProviderEvent(type="done")]
        await send(client, convo["id"], content="one more turn")
    payload = fake_provider.captured["payload"]
    assert len(payload.messages) == 4

    too_low = await client.put("/api/settings", json={"history_limit": 1})
    assert too_low.status_code == 422  # bounded: ge=4


async def test_consolidate_merges_facts(client, fake_provider):
    convo = await setup_conversation(client)
    for i in range(10):
        await client.post(f"/api/conversations/{convo['id']}/memories",
                          json={"content": f"Redundant fact number {i} about the same thing."})
    await client.post(f"/api/conversations/{convo['id']}/memories",
                      json={"content": "Crucial pinned fact.", "is_pinned": True})
    # user-added facts are source="user"; make them look auto so consolidation
    # moves them, with spread-out positions to check the merged stamp
    from app.db import _connect
    db = await _connect()
    await db.execute("UPDATE memories SET source='auto', source_position=30 WHERE is_pinned=0")
    await db.execute("UPDATE memories SET source_position=5 WHERE content LIKE '%number 3%'")
    await db.commit()
    await db.close()

    merged = json.dumps({"facts": [
        {"content": "Three facts merged into a single dense one.", "kind": "fact"},
        {"content": "A second synthesized fact.", "kind": "event"},
    ]})
    fake_provider.script = [ProviderEvent(type="delta", text=merged), ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/consolidate")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["before"] == 11 and body["after"] == 3  # 2 merged + 1 pinned kept
    contents = {m["content"] for m in body["memories"]}
    assert "Crucial pinned fact." in contents  # pinned survived
    assert "Three facts merged into a single dense one." in contents
    # merged facts inherit the OLDEST source position (long-term memory must
    # not look recent, or the visible-window filter would mute it)
    merged_rows = [m for m in body["memories"] if m["source"] == "auto"]
    assert merged_rows and all(m["source_position"] == 5 for m in merged_rows)


async def test_consolidate_skips_when_few_facts(client, fake_provider):
    convo = await setup_conversation(client)
    await client.post(f"/api/conversations/{convo['id']}/memories", json={"content": "Un seul fait."})
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/consolidate")
    assert resp.status_code == 200
    assert resp.json().get("skipped") == "too_few"


async def test_embedding_stored_and_excluded_from_output(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import memories as mem_repo

    async def fake_embed(texts, kind):
        return [[0.5, 0.5]]  # non-None -> add() stores a blob

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    convo = await setup_conversation(client)
    created = (await client.post(f"/api/conversations/{convo['id']}/memories",
                                 json={"content": "A vectorized fact."})).json()
    assert "embedding" not in created  # bytes never leak into the API payload

    db = await _connect()
    try:
        emb_map = await mem_repo.list_embeddings(db, convo["id"])
        assert created["id"] in emb_map
        assert isinstance(emb_map[created["id"]], (bytes, memoryview))
    finally:
        await db.close()


async def test_list_missing_and_set_embedding(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import memories as mem_repo

    async def no_embed(texts, kind):
        return None  # model not ready -> stored as NULL

    monkeypatch.setattr(embeddings, "embed", no_embed)
    convo = await setup_conversation(client)
    created = (await client.post(f"/api/conversations/{convo['id']}/memories",
                                 json={"content": "Fact without a vector."})).json()

    db = await _connect()
    try:
        missing = await mem_repo.list_missing_embeddings(db)
        assert any(m["id"] == created["id"] for m in missing)
        await mem_repo.set_embedding(db, created["id"], embeddings.pack([0.1, 0.2]))
        missing_after = await mem_repo.list_missing_embeddings(db)
        assert all(m["id"] != created["id"] for m in missing_after)
    finally:
        await db.close()


async def test_backfill_embeddings_fills_missing(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import memories as mem_repo
    from app.services import memory_service

    async def no_embed(texts, kind):
        return None  # created as NULL

    monkeypatch.setattr(embeddings, "embed", no_embed)
    convo = await setup_conversation(client)
    await client.post(f"/api/conversations/{convo['id']}/memories", json={"content": "A."})
    await client.post(f"/api/conversations/{convo['id']}/memories", json={"content": "B."})

    async def now_embed(texts, kind):
        return [[0.3, 0.4] for _ in texts]

    monkeypatch.setattr(embeddings, "embed", now_embed)
    db = await _connect()
    try:
        filled = await memory_service.backfill_embeddings(db)
        assert filled == 2
        assert await mem_repo.list_missing_embeddings(db) == []
    finally:
        await db.close()


async def test_backfill_noop_without_model(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.services import memory_service

    async def no_embed(texts, kind):
        return None

    monkeypatch.setattr(embeddings, "embed", no_embed)
    convo = await setup_conversation(client)
    await client.post(f"/api/conversations/{convo['id']}/memories", json={"content": "A."})
    db = await _connect()
    try:
        assert await memory_service.backfill_embeddings(db) == 0  # nothing embedded, no crash
    finally:
        await db.close()


async def test_chat_service_passes_relevance_scores(client, fake_provider, monkeypatch):
    """chat_service builds the scene, loads the embedding map, ranks the facts,
    and passes relevance_scores to the prompt builder."""
    import app.services.chat_service as cs
    from app.prompting import embeddings

    async def fake_embed(texts, kind):
        return [[1.0, 0.0] if "crypt" in t.lower() else [0.0, 1.0] for t in texts]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    await client.put("/api/settings", json={"auto_memory": False})  # no background facts
    convo = await setup_conversation(client)
    crypte = (await client.post(f"/api/conversations/{convo['id']}/memories",
                                json={"content": "The crypt seal was broken."})).json()
    meteo = (await client.post(f"/api/conversations/{convo['id']}/memories",
                               json={"content": "The weather was fine that day."})).json()
    # force both facts out of the visible window (anti-echo keeps them as candidates)
    from app.db import _connect
    db = await _connect()
    await db.execute("UPDATE memories SET source_position = 1")
    await db.commit()
    await db.close()

    captured = {}
    real = cs.build_chat_payload

    def spy(**kwargs):
        captured.update(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(cs, "build_chat_payload", spy)
    for _ in range(13):  # advance the window past the facts' position
        fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                                ProviderEvent(type="done")]
        await send(client, convo["id"], content="on avance")
    fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                            ProviderEvent(type="done")]
    await send(client, convo["id"], content="Tell me about the crypt.")

    scores = captured.get("relevance_scores")
    assert scores is not None
    assert scores[crypte["id"]] > scores[meteo["id"]]  # crypt-themed scene wins


async def test_update_content_refreshes_embedding(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import memories as mem_repo

    calls = {"n": 0}

    async def fake_embed(texts, kind):
        calls["n"] += 1
        return [[float(calls["n"]), 0.0]]  # distinct vector per call

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    convo = await setup_conversation(client)
    created = (await client.post(f"/api/conversations/{convo['id']}/memories",
                                 json={"content": "Version one."})).json()
    db = await _connect()
    try:
        before = (await mem_repo.list_embeddings(db, convo["id"]))[created["id"]]
    finally:
        await db.close()

    await client.patch(f"/api/memories/{created['id']}",
                       json={"content": "Version two, very different."})
    db = await _connect()
    try:
        after = (await mem_repo.list_embeddings(db, convo["id"]))[created["id"]]
    finally:
        await db.close()
    assert bytes(before) != bytes(after)  # vector refreshed to match new content


async def test_update_content_nulls_embedding_without_model(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import memories as mem_repo

    async def has_embed(texts, kind):
        return [[0.5, 0.5]]

    monkeypatch.setattr(embeddings, "embed", has_embed)
    convo = await setup_conversation(client)
    created = (await client.post(f"/api/conversations/{convo['id']}/memories",
                                 json={"content": "With vector."})).json()

    async def no_embed(texts, kind):
        return None

    monkeypatch.setattr(embeddings, "embed", no_embed)
    await client.patch(f"/api/memories/{created['id']}", json={"content": "Modified text."})
    db = await _connect()
    try:
        missing = await mem_repo.list_missing_embeddings(db)
        assert any(m["id"] == created["id"] for m in missing)  # NULLed for backfill
    finally:
        await db.close()


async def test_fork_copies_fact_embedding(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import memories as mem_repo

    async def fake_embed(texts, kind):
        return [[0.6, 0.8]]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="first turn")
    await client.post(f"/api/conversations/{convo['id']}/memories",
                      json={"content": "Fact to copy with vector."})  # source_position 0
    msgs = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    fork_at = msgs[1]  # position >= the fact's source_position (0)
    branch = (await client.post(f"/api/messages/{fork_at['id']}/branch")).json()

    db = await _connect()
    try:
        emb = await mem_repo.list_embeddings(db, branch["id"])
        assert len(emb) == 1  # copied fact carries its vector (not NULL)
    finally:
        await db.close()


async def test_backfill_message_embeddings_fills_missing(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import conversations as convo_repo
    from app.services import memory_service

    async def now_embed(texts, kind):
        return [[0.3, 0.4] for _ in texts]

    monkeypatch.setattr(embeddings, "embed", now_embed)
    await setup_conversation(client)  # seeds a greeting message
    db = await _connect()
    try:
        filled = await memory_service.backfill_message_embeddings(db)
        assert filled >= 1
        assert await convo_repo.list_messages_missing_embeddings(db) == []
    finally:
        await db.close()


async def test_backfill_messages_noop_without_model(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.services import memory_service

    async def no_embed(texts, kind):
        return None

    monkeypatch.setattr(embeddings, "embed", no_embed)
    await setup_conversation(client)
    db = await _connect()
    try:
        assert await memory_service.backfill_message_embeddings(db) == 0
    finally:
        await db.close()


async def test_passage_budget_setting(client, fake_provider):
    updated = (await client.put("/api/settings", json={"passage_budget": 800})).json()
    assert updated["passage_budget"] == 800
    fresh = (await client.get("/api/settings")).json()
    assert "passage_budget" in fresh
    too_big = await client.put("/api/settings", json={"passage_budget": 99999})
    assert too_big.status_code == 422  # bounded 0..4000


async def test_relevant_passage_retrieved_into_prompt(client, fake_provider, monkeypatch):
    """An old, out-of-window message that matches the current scene is injected
    verbatim under RELEVANT PAST."""
    from app.prompting import embeddings

    async def fake_embed(texts, kind):
        return [[1.0, 0.0] if "crypt" in t.lower() else [0.0, 1.0] for t in texts]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    await client.put("/api/settings", json={"auto_memory": False, "history_limit": 6,
                                            "passage_budget": 1500})
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="We sealed the crypt that night.")
    for _ in range(8):
        fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                                ProviderEvent(type="done")]
        await send(client, convo["id"], content="we talk about the weather")
    fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                            ProviderEvent(type="done")]
    await send(client, convo["id"], content="Tell me about the crypt again.")
    system = fake_provider.captured["payload"].system
    assert "### RELEVANT PAST" in system
    assert "crypt that night" in system  # the old message resurfaced verbatim


async def test_passages_off_when_budget_zero(client, fake_provider, monkeypatch):
    from app.prompting import embeddings

    async def fake_embed(texts, kind):
        return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    await client.put("/api/settings", json={"auto_memory": False, "history_limit": 6,
                                            "passage_budget": 0})
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="We sealed the crypt.")
    for _ in range(8):
        fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                                ProviderEvent(type="done")]
        await send(client, convo["id"], content="something else")
    fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                            ProviderEvent(type="done")]
    await send(client, convo["id"], content="Tell me about the crypt again.")
    assert "### RELEVANT PAST" not in fake_provider.captured["payload"].system
