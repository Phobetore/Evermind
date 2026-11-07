"""The reply is written while it streams, not only once it is finished.

A server that goes down leaves a turn anywhere, and nothing afterwards gets to save what had
arrived: writing as it goes means whatever arrived is already kept, marked as cut short until
the last write says it is whole.
"""

import asyncio

import pytest

from app.models.schemas import ChatRequest
from app.providers.base import ProviderEvent
from app.services import turns
from tests.test_chat import messages_of, setup_conversation


class HeldBack:
    """Five words, then nothing more until the test lets it go."""

    let_go: asyncio.Event

    def __init__(self, connection):
        self.connection = connection

    async def stream_chat(self, payload):
        for i in range(5):
            yield ProviderEvent(type="delta", text=f"mot{i} ")
        await HeldBack.let_go.wait()
        yield ProviderEvent(type="delta", text="fin")
        yield ProviderEvent(type="done")


@pytest.fixture()
def held_back(monkeypatch):
    HeldBack.let_go = asyncio.Event()
    monkeypatch.setattr("app.services.chat_service.get_provider", HeldBack)
    monkeypatch.setattr("app.services.chat_service._FLUSH_SECONDS", 0)


async def test_a_server_going_down_keeps_every_word_written_and_says_it_was_cut_short(
        client, held_back):
    convo = await setup_conversation(client)
    turn = await turns.start(ChatRequest(conversation_id=convo["id"], mode="send", content="Coupe-moi"))

    async def written():
        while "mot4" not in (await messages_of(client, convo["id"]))[-1]["content"]:
            await asyncio.sleep(0.01)

    await asyncio.wait_for(written(), timeout=10)
    turn.task.cancel()  # what a server shutting down does to it
    await asyncio.wait_for(turn.finished.wait(), timeout=5)

    reply = (await messages_of(client, convo["id"]))[-1]
    assert reply["role"] == "assistant"
    assert reply["content"] == "mot0 mot1 mot2 mot3 mot4"
    assert reply["meta"] == {"interrupted": [0]}
    assert await turns.running_for(convo["id"]) is None


async def test_a_reply_says_it_is_unfinished_until_it_is_whole(client, held_back):
    convo = await setup_conversation(client)
    turn = await turns.start(ChatRequest(conversation_id=convo["id"], mode="send", content="Ecris-moi"))

    async def cut_short():
        while (await messages_of(client, convo["id"]))[-1]["meta"].get("interrupted") != [0]:
            await asyncio.sleep(0.01)

    await asyncio.wait_for(cut_short(), timeout=10)
    HeldBack.let_go.set()
    await asyncio.wait_for(turn.finished.wait(), timeout=10)

    messages = await messages_of(client, convo["id"])
    assert [m["role"] for m in messages] == ["assistant", "user", "assistant"], "a write added a message"
    assert messages[-1]["content"] == "mot0 mot1 mot2 mot3 mot4 fin"
    assert "interrupted" not in messages[-1]["meta"]
