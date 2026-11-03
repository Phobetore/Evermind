"""A model that fails after it began to write.

What had arrived is the reply, as far as it goes: the person watched it come, and
stopping a turn keeps every word of it. A failure ends the turn the same way, and
says that it failed, so that none of it is thrown away for the sake of the sentence
that explains why it stops.
"""

import asyncio

import pytest

from app.db import _connect
from app.errors import MODEL_ERROR
from app.models.schemas import ChatRequest
from app.providers.base import ProviderEvent, failure
from app.services import chat_service

from .test_chat import FakeProvider, send, setup_conversation

FAILS_AFTER_TWO_WORDS = [
    ProviderEvent(type="delta", text="The door "),
    ProviderEvent(type="delta", text="creaks open"),
    ProviderEvent(type="error", message="The server went away.", meta=failure(MODEL_ERROR)),
]


@pytest.fixture()
def provider(monkeypatch):
    FakeProvider.script = [ProviderEvent(type="delta", text="Complete."),
                           ProviderEvent(type="done")]
    FakeProvider.captured = {}
    monkeypatch.setattr("app.services.chat_service.get_provider", FakeProvider)
    return FakeProvider


async def messages_of(client, convo_id):
    return (await client.get(f"/api/conversations/{convo_id}")).json()["messages"]


async def test_a_reply_cut_short_by_a_failure_is_kept_and_the_failure_is_said(client, provider):
    convo = await setup_conversation(client)
    provider.script = FAILS_AFTER_TWO_WORDS

    events = await send(client, convo["id"], content="Knock")

    assert [e["type"] for e in events] == ["start", "delta", "delta", "error"]
    assert events[-1]["kind"] == "model_error"
    assert events[-1]["message"] == "The server went away."
    messages = await messages_of(client, convo["id"])
    assert [m["role"] for m in messages] == ["assistant", "user", "assistant"]
    assert messages[-1]["content"] == "The door creaks open"
    # The person has a reply to go on from, so nothing is left waiting for one.
    assert "unanswered" not in messages[1]["meta"]


async def test_a_failure_before_any_word_leaves_the_message_waiting_for_its_reply(client, provider):
    convo = await setup_conversation(client)
    provider.script = [ProviderEvent(type="error", message="Down.", meta=failure(MODEL_ERROR))]

    events = await send(client, convo["id"], content="Knock")

    assert events[-1]["type"] == "error"
    messages = await messages_of(client, convo["id"])
    assert [m["role"] for m in messages] == ["assistant", "user"]
    assert messages[-1]["meta"]["unanswered"] is True


async def test_a_regeneration_cut_short_by_a_failure_keeps_its_words_as_a_variant(client, provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="Knock")
    provider.script = FAILS_AFTER_TWO_WORDS

    events = await send(client, convo["id"], content=None, mode="regenerate")

    assert events[-1]["type"] == "error"
    reply = (await messages_of(client, convo["id"]))[-1]
    assert reply["variants"] == ["Complete.", "The door creaks open"]
    assert reply["active_index"] == 1


async def test_a_regeneration_for_a_message_without_a_reply_keeps_what_arrived(client, provider):
    """After a failure that left nothing, a regeneration writes the missing reply."""
    convo = await setup_conversation(client)
    provider.script = [ProviderEvent(type="error", message="Down.", meta=failure(MODEL_ERROR))]
    await send(client, convo["id"], content="Knock")
    provider.script = FAILS_AFTER_TWO_WORDS

    events = await send(client, convo["id"], content=None, mode="regenerate")

    assert events[-1]["type"] == "error"
    messages = await messages_of(client, convo["id"])
    assert [m["role"] for m in messages] == ["assistant", "user", "assistant"]
    assert messages[-1]["content"] == "The door creaks open"
    assert "unanswered" not in messages[1]["meta"]


async def test_a_continuation_cut_short_by_a_failure_keeps_its_words(client, provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="Knock")
    provider.script = FAILS_AFTER_TWO_WORDS

    events = await send(client, convo["id"], content=None, mode="continue")

    assert events[-1]["type"] == "error"
    reply = (await messages_of(client, convo["id"]))[-1]
    assert reply["content"] == "Complete. The door creaks open"
    assert reply["variants"] == ["Complete. The door creaks open"]


async def test_a_continuation_that_fails_before_any_word_changes_nothing(client, provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="Knock")
    before = await messages_of(client, convo["id"])
    provider.script = [ProviderEvent(type="error", message="Down.", meta=failure(MODEL_ERROR))]

    events = await send(client, convo["id"], content=None, mode="continue")

    assert events[-1]["type"] == "error"
    assert await messages_of(client, convo["id"]) == before


async def test_the_conversation_read_after_a_failure_shows_the_reply_as_cut_short(client, provider):
    """What the page draws once the turn is over is a read of the conversation: the
    words are there, marked as a reply that was not finished like one that was stopped."""
    convo = await setup_conversation(client)
    provider.script = FAILS_AFTER_TWO_WORDS
    await send(client, convo["id"], content="Knock")

    reply = (await messages_of(client, convo["id"]))[-1]

    assert reply["meta"] == {"streaming": True}
    # The next turn settles the mark, as it does for a stopped one.
    provider.script = [ProviderEvent(type="delta", text="Again."), ProviderEvent(type="done")]
    await send(client, convo["id"], content="Knock again")
    settled = (await messages_of(client, convo["id"]))[-3]
    assert settled["content"] == "The door creaks open"
    assert settled["meta"] == {"interrupted": True}


async def test_a_failure_after_the_message_was_deleted_ends_the_turn_without_a_reply(
        client, monkeypatch):
    """The person took the message back while the model was writing, and the model failed
    after that: there is nothing to keep the words in, and nothing to report a failure of."""
    delta_sent, gate = asyncio.Event(), asyncio.Event()

    class FailsAfterTheMessageIsGone:
        def __init__(self, connection):
            pass

        async def stream_chat(self, payload):
            yield ProviderEvent(type="delta", text="Half a reply")
            delta_sent.set()
            await gate.wait()
            yield ProviderEvent(type="error", message="Down.", meta=failure(MODEL_ERROR))

    monkeypatch.setattr("app.services.chat_service.get_provider", FailsAfterTheMessageIsGone)
    convo = await setup_conversation(client)
    db = await _connect()
    events: list[str] = []

    async def run():
        async for chunk in chat_service.stream_turn(
                db, ChatRequest(conversation_id=convo["id"], mode="send", content="Gone soon")):
            events.append(chunk)

    turn = asyncio.create_task(run())
    try:
        await asyncio.wait_for(delta_sent.wait(), 5)
        mine = next(m for m in await messages_of(client, convo["id"]) if m["role"] == "user")
        await client.delete(f"/api/messages/{mine['id']}?following=true")
    finally:
        gate.set()
    await asyncio.wait_for(turn, 5)
    await db.close()

    assert events[-1] == 'data: {"type": "discarded"}\n\n'
    assert [m["role"] for m in await messages_of(client, convo["id"])] == ["assistant"]
