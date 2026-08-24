"""The reply is written while it streams, not only once it is finished.

Closing a tab tears the request down, and nothing afterwards reliably still has
a database connection to save with: a handler that tried used to sit here and
was never once reached under a real disconnect. Writing as we go means whatever
arrived is already kept, without depending on cleanup at all.

The turn is driven as a generator here rather than through the test client: the
ASGI transport buffers the whole response before handing over a single line, so
a stream cannot be interrupted, or even observed, half way through it.
"""

import asyncio

import pytest

from app.db import _connect
from app.models.schemas import ChatRequest
from app.providers.base import ProviderEvent
from app.services import chat_service
from tests.test_chat import setup_conversation


class UnhurriedProvider:
    """Streams slowly enough that the turn can be cut in the middle of it."""

    def __init__(self, connection):
        self.connection = connection

    async def stream_chat(self, payload):
        for i in range(12):
            yield ProviderEvent(type="delta", text=f"mot{i} ")
            await asyncio.sleep(0.08)
        yield ProviderEvent(type="done")


@pytest.fixture()
def unhurried(monkeypatch):
    monkeypatch.setattr("app.services.chat_service.get_provider", UnhurriedProvider)
    monkeypatch.setattr("app.services.memory_service.get_provider", UnhurriedProvider)


async def _messages(client, convo_id):
    return (await client.get(f"/api/conversations/{convo_id}")).json()["messages"]


async def test_a_turn_cut_short_keeps_what_had_arrived(client, unhurried):
    convo = await setup_conversation(client)

    db = await _connect()
    try:
        turn = chat_service.stream_turn(
            db, ChatRequest(conversation_id=convo["id"], mode="send", content="Coupe-moi")
        )
        deltas = 0
        async for chunk in turn:
            if '"delta"' in chunk:
                deltas += 1
                if deltas >= 6:
                    break  # the reader goes away, as a closed tab does
        await turn.aclose()
    finally:
        await db.close()

    messages = await _messages(client, convo["id"])
    assert deltas >= 6
    assert messages[-1]["role"] == "assistant", (
        f"the text already generated should survive, got {[m['role'] for m in messages]}"
    )
    assert messages[-1]["content"].startswith("mot0")
    assert messages[-1]["meta"].get("streaming") is True, (
        "a reply that never finished should say so, so it can be told apart "
        "from one the model simply kept short"
    )


async def test_the_next_turn_settles_a_reply_left_mid_write(client, unhurried):
    """The mark says "a turn is writing this right now". When the reader goes
    away there is nothing left to clear it, so it outlives the turn — and the
    chat view hides anything carrying it while a turn is live, which made an
    interrupted reply vanish on every generation afterwards, most visibly the
    moment you tried to continue it. By the time another turn starts nothing is
    writing it any more, so it is settled into what it really is."""
    convo = await setup_conversation(client)

    db = await _connect()
    try:
        turn = chat_service.stream_turn(
            db, ChatRequest(conversation_id=convo["id"], mode="send", content="Coupe-moi")
        )
        deltas = 0
        async for chunk in turn:
            if '"delta"' in chunk:
                deltas += 1
                if deltas >= 4:
                    break
        await turn.aclose()
    finally:
        await db.close()

    stranded = (await _messages(client, convo["id"]))[-1]
    assert stranded["meta"].get("streaming") is True

    await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "continue",
    })

    settled = next(m for m in await _messages(client, convo["id"]) if m["id"] == stranded["id"])
    assert "streaming" not in settled["meta"], (
        "a stale mark keeps the reply hidden through every later turn"
    )
    assert settled["meta"].get("interrupted") is True, (
        "the view already knows how to label an interrupted reply; nothing was "
        "ever setting the key it reads"
    )


async def test_the_streaming_mark_is_cleared_once_the_reply_lands(client, unhurried):
    convo = await setup_conversation(client)
    resp = await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "send", "content": "Ecris-moi",
    })
    assert resp.status_code == 200

    messages = await _messages(client, convo["id"])
    assert messages[-1]["content"].strip().endswith("mot11")
    assert "streaming" not in messages[-1]["meta"]


async def test_the_reply_is_one_message_not_one_per_flush(client, unhurried):
    """Every flush rewrites the same row; a fresh insert each time would stack up."""
    convo = await setup_conversation(client)
    await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "send", "content": "Ecris-moi",
    })

    roles = [m["role"] for m in await _messages(client, convo["id"])]
    assert roles == ["assistant", "user", "assistant"], roles
