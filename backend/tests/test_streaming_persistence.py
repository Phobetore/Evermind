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
from tests.test_chat import messages_of, send, setup_conversation


class UnhurriedProvider:
    """Streams slowly enough that the turn can be cut in the middle of it."""

    def __init__(self, connection):
        self.connection = connection

    async def stream_chat(self, payload):
        for i in range(12):
            yield ProviderEvent(type="delta", text=f"mot{i} ")
            await asyncio.sleep(0.08)
        yield ProviderEvent(type="done")


class FiveWordsThenNothing:
    """Five words, then a model that says nothing more until the turn goes."""

    def __init__(self, connection):
        self.connection = connection

    async def stream_chat(self, payload):
        for i in range(5):
            yield ProviderEvent(type="delta", text=f"mot{i} ")
        await asyncio.Event().wait()
        yield ProviderEvent(type="done")  # pragma: no cover


@pytest.fixture()
def unhurried(monkeypatch):
    monkeypatch.setattr("app.services.chat_service.get_provider", UnhurriedProvider)
    monkeypatch.setattr("app.services.memory_service.get_provider", UnhurriedProvider)


async def test_a_server_going_down_keeps_every_word_written_and_says_it_was_cut_short(
        client, monkeypatch):
    monkeypatch.setattr("app.services.chat_service.get_provider", FiveWordsThenNothing)
    monkeypatch.setattr("app.services.chat_service._FLUSH_SECONDS", 0)
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


async def test_a_reply_says_it_is_unfinished_until_it_is_whole(client, unhurried):
    convo = await setup_conversation(client)
    turn = await turns.start(ChatRequest(conversation_id=convo["id"], mode="send", content="Ecris-moi"))

    async def begun():
        while (await messages_of(client, convo["id"]))[-1]["role"] != "assistant":
            await asyncio.sleep(0.02)

    await asyncio.wait_for(begun(), timeout=10)
    assert (await messages_of(client, convo["id"]))[-1]["meta"]["interrupted"] == [0]
    await asyncio.wait_for(turn.finished.wait(), timeout=15)

    reply = (await messages_of(client, convo["id"]))[-1]
    assert reply["content"].strip().endswith("mot11")
    assert "interrupted" not in reply["meta"]


async def test_the_reply_is_one_message_not_one_per_flush(client, unhurried):
    """Every flush rewrites the same row; a fresh insert each time would stack up."""
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="Ecris-moi")

    roles = [m["role"] for m in await messages_of(client, convo["id"])]
    assert roles == ["assistant", "user", "assistant"], roles
