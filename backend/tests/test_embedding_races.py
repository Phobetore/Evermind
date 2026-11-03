"""A vector describes the text it was computed from.

Working one out takes a while, and the person can change the text meanwhile. A vector
written afterwards would sit beside a text it does not describe, and be believed:
semantic recall would rank a fact or a past passage by words that are gone.
"""

import pytest

from app.db import _connect
from app.prompting import embeddings
from app.providers.base import ProviderEvent
from app.repositories import conversations as convo_repo
from app.repositories import memories as memories_repo
from app.services import memory_service

from .test_chat import FakeProvider, send, setup_conversation


@pytest.fixture()
def provider(monkeypatch):
    FakeProvider.script = [ProviderEvent(type="delta", text="Reply."), ProviderEvent(type="done")]
    FakeProvider.captured = {}
    monkeypatch.setattr("app.services.chat_service.get_provider", FakeProvider)
    return FakeProvider


@pytest.fixture()
def no_model(monkeypatch):
    """New facts and messages start without a vector, as before the model is loaded."""

    async def nothing(texts, kind):
        return None

    monkeypatch.setattr(embeddings, "embed", nothing)


def vector_of(text: str) -> list[float]:
    """A vector that says which text it came from."""
    return [float(len(text)), float(sum(map(ord, text)) % 97)]


def embed_while(monkeypatch, meanwhile):
    """An embedding model that, while it works on a text, lets ``meanwhile`` happen."""
    seen: list[str] = []

    async def embed(texts, kind):
        seen.extend(texts)
        await meanwhile(texts)
        return [vector_of(text) for text in texts]

    monkeypatch.setattr(embeddings, "embed", embed)
    return seen


async def meanwhile_nothing(texts):
    return None


def values(blob) -> list[float]:
    return [float(x) for x in embeddings.unpack(blob)]


async def stored_vector(db, table, row_id):
    row = await (await db.execute(
        f"SELECT embedding FROM {table} WHERE id = ?", (row_id,))).fetchone()
    return None if row["embedding"] is None else values(row["embedding"])


# ---------- facts ----------

async def test_a_vector_is_set_only_on_the_text_it_was_computed_from(client, no_model):
    convo = await setup_conversation(client)
    fact = (await client.post(f"/api/conversations/{convo['id']}/memories",
                              json={"content": "She keeps the key."})).json()
    db = await _connect()
    try:
        elsewhere = await memories_repo.set_embedding(
            db, fact["id"], "She lost the key.", embeddings.pack([1.0, 2.0]))
        assert elsewhere is False
        assert await stored_vector(db, "memories", fact["id"]) is None

        here = await memories_repo.set_embedding(
            db, fact["id"], "She keeps the key.", embeddings.pack([1.0, 2.0]))
        assert here is True
        assert await stored_vector(db, "memories", fact["id"]) == [1.0, 2.0]
    finally:
        await db.close()


async def test_a_fact_rewritten_while_its_vector_is_worked_out_gets_no_stale_one(
        client, no_model, monkeypatch):
    convo = await setup_conversation(client)
    fact = (await client.post(f"/api/conversations/{convo['id']}/memories",
                              json={"content": "She keeps the key."})).json()

    async def rewrite(texts):
        other = await _connect()
        try:
            await other.execute("UPDATE memories SET content = 'She lost the key.',"
                                " embedding = NULL WHERE id = ?", (fact["id"],))
            await other.commit()
        finally:
            await other.close()

    db = await _connect()
    try:
        calls = embed_while(monkeypatch, rewrite)
        filled = await memory_service.backfill_embeddings(db)

        assert calls == ["She keeps the key."]
        assert filled == 0
        assert await stored_vector(db, "memories", fact["id"]) is None
        # And what is left to do is done on the next pass, on the text that is there.
        embed_while(monkeypatch, meanwhile_nothing)
        assert await memory_service.backfill_embeddings(db) == 1
        assert await stored_vector(db, "memories", fact["id"]) == vector_of("She lost the key.")
    finally:
        await db.close()


async def test_a_fact_that_did_not_change_gets_its_vector(client, no_model, monkeypatch):
    convo = await setup_conversation(client)
    fact = (await client.post(f"/api/conversations/{convo['id']}/memories",
                              json={"content": "She keeps the key."})).json()
    embed_while(monkeypatch, meanwhile_nothing)
    db = await _connect()
    try:
        assert await memory_service.backfill_embeddings(db) == 1
        assert await stored_vector(db, "memories", fact["id"]) == vector_of("She keeps the key.")
    finally:
        await db.close()


# ---------- messages ----------

async def a_reply_with_two_variants(client, provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="Knock")
    provider.script = [ProviderEvent(type="delta", text="Second take."),
                       ProviderEvent(type="done")]
    await send(client, convo["id"], content=None, mode="regenerate")
    reply = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"][-1]
    assert reply["variants"] == ["Reply.", "Second take."]
    # Back to the first, which is the text the vector is worked out for.
    await client.patch(f"/api/messages/{reply['id']}", json={"active_index": 0})
    return convo, reply


async def message_vectors(db, convo_id):
    return await convo_repo.list_message_embeddings(db, convo_id)


async def test_a_message_edited_while_its_vector_is_worked_out_gets_no_stale_one(
        client, provider, no_model, monkeypatch):
    convo, reply = await a_reply_with_two_variants(client, provider)

    async def edit(texts):
        await client.patch(f"/api/messages/{reply['id']}", json={"content": "Edited meanwhile."})

    db = await _connect()
    try:
        calls = embed_while(monkeypatch, edit)
        await memory_service.backfill_message_embeddings(db)

        assert "Reply." in calls
        assert reply["id"] not in await message_vectors(db, convo["id"])
        missing = [m["id"] for m in await convo_repo.list_messages_missing_embeddings(db)]
        assert reply["id"] in missing  # left for the next pass
    finally:
        await db.close()


async def test_a_message_swiped_while_its_vector_is_worked_out_gets_no_stale_one(
        client, provider, no_model, monkeypatch):
    """The text of a message is its active variant: choosing another is a change of it."""
    convo, reply = await a_reply_with_two_variants(client, provider)

    async def swipe(texts):
        await client.patch(f"/api/messages/{reply['id']}", json={"active_index": 1})

    db = await _connect()
    try:
        embed_while(monkeypatch, swipe)
        await memory_service.backfill_message_embeddings(db)

        assert reply["id"] not in await message_vectors(db, convo["id"])
    finally:
        await db.close()


async def test_a_message_that_did_not_change_gets_its_vector(client, provider, no_model, monkeypatch):
    convo, reply = await a_reply_with_two_variants(client, provider)
    embed_while(monkeypatch, meanwhile_nothing)
    db = await _connect()
    try:
        filled = await memory_service.backfill_message_embeddings(db)

        assert filled >= 1
        vectors = await message_vectors(db, convo["id"])
        assert values(vectors[reply["id"]]) == vector_of("Reply.")
    finally:
        await db.close()


async def test_a_message_vector_is_set_only_on_the_text_it_was_computed_from(
        client, provider, no_model):
    convo, reply = await a_reply_with_two_variants(client, provider)
    db = await _connect()
    try:
        elsewhere = await convo_repo.set_message_embedding(
            db, reply["id"], "Second take.", embeddings.pack([1.0, 2.0]))
        assert elsewhere is False
        assert reply["id"] not in await message_vectors(db, convo["id"])

        here = await convo_repo.set_message_embedding(
            db, reply["id"], "Reply.", embeddings.pack([1.0, 2.0]))
        assert here is True
        assert reply["id"] in await message_vectors(db, convo["id"])
    finally:
        await db.close()


async def test_a_message_that_is_gone_gets_nothing(client, provider, no_model):
    _, reply = await a_reply_with_two_variants(client, provider)
    db = await _connect()
    try:
        await convo_repo.delete_message(db, reply["id"])
        assert await convo_repo.set_message_embedding(
            db, reply["id"], "Reply.", embeddings.pack([1.0, 2.0])) is False
    finally:
        await db.close()
