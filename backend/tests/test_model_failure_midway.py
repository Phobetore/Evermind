"""A model that fails after it began to write.

What had arrived is the reply, as far as it goes: the person watched it come, and
stopping a turn keeps every word of it. A failure ends the turn the same way, and
says that it failed, so that none of it is thrown away for the sake of the sentence
that explains why it stops.
"""

import pytest

from app.providers.base import ProviderError, ProviderEvent

from .conftest import FakeProvider, send, setup_conversation

FAILS_AFTER_TWO_WORDS = [
    ProviderEvent(type="delta", text="The door "),
    ProviderEvent(type="delta", text="creaks open"),
    ProviderError("The server went away."),
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

    outcome = await send(client, convo["id"], content="Knock")

    assert outcome == {"kind": "model_error", "message": "The server went away.", "mode": "send"}
    messages = await messages_of(client, convo["id"])
    assert [m["role"] for m in messages] == ["assistant", "user", "assistant"]
    assert messages[-1]["content"] == "The door creaks open"
    # The person has a reply to go on from, so nothing is left waiting for one.
    assert "unanswered" not in messages[1]["meta"]


async def test_a_failure_before_any_word_leaves_the_message_waiting_for_its_reply(client, provider):
    convo = await setup_conversation(client)
    provider.script = [ProviderError("Down.")]

    await send(client, convo["id"], content="Knock")

    messages = await messages_of(client, convo["id"])
    assert [m["role"] for m in messages] == ["assistant", "user"]
    # And why, for a page that opens on it later.
    assert messages[-1]["meta"]["unanswered"] == {"kind": "model_error", "message": "Down."}


async def test_a_regeneration_cut_short_by_a_failure_keeps_its_words_as_a_variant(client, provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="Knock")
    provider.script = FAILS_AFTER_TWO_WORDS

    assert await send(client, convo["id"], content=None, mode="regenerate")

    reply = (await messages_of(client, convo["id"]))[-1]
    assert reply["variants"] == ["Complete.", "The door creaks open"]
    assert reply["active_index"] == 1


async def test_a_continuation_cut_short_by_a_failure_keeps_its_words(client, provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="Knock")
    provider.script = FAILS_AFTER_TWO_WORDS

    assert await send(client, convo["id"], content=None, mode="continue")

    reply = (await messages_of(client, convo["id"]))[-1]
    assert reply["content"] == "Complete. The door creaks open"
    assert reply["variants"] == ["Complete. The door creaks open"]


async def test_the_conversation_read_after_a_failure_says_the_reply_was_cut_short(client, provider):
    """What the page draws once the turn is over, or after a reload, is a read of the
    conversation. The turn knows that it failed, unlike one that was stopped, so it says
    so at once and not when the next one starts."""
    convo = await setup_conversation(client)
    provider.script = FAILS_AFTER_TWO_WORDS
    await send(client, convo["id"], content="Knock")

    reply = (await messages_of(client, convo["id"]))[-1]

    assert reply["meta"].get("interrupted") == [0]
    # And the next turn leaves it so.
    provider.script = [ProviderEvent(type="delta", text="Again."), ProviderEvent(type="done")]
    await send(client, convo["id"], content="Knock again")
    kept = (await messages_of(client, convo["id"]))[-3]
    assert kept["content"] == "The door creaks open"
    assert kept["meta"].get("interrupted") == [0]


async def test_finishing_a_reply_that_was_cut_short_takes_the_label_away(client, provider):
    """Continuing a partial reply completes that version; leaving "interrupted" on it
    would label a whole reply for good."""
    convo = await setup_conversation(client)
    provider.script = FAILS_AFTER_TWO_WORDS
    await send(client, convo["id"], content="Knock")
    assert (await messages_of(client, convo["id"]))[-1]["meta"].get("interrupted") == [0]
    provider.script = [ProviderEvent(type="delta", text="the rest."), ProviderEvent(type="done")]

    assert await send(client, convo["id"], content=None, mode="continue") is None

    reply = (await messages_of(client, convo["id"]))[-1]
    assert "interrupted" not in reply["meta"]


async def test_a_failure_that_is_not_a_model_event_keeps_what_arrived_too(client, monkeypatch):
    """A chunk that is not what the stream was promised to hold raises instead of
    failing as an event, from somewhere inside the provider."""

    class Breaks:
        def __init__(self, connection):
            pass

        async def stream_chat(self, payload):
            yield ProviderEvent(type="delta", text="The door ")
            yield ProviderEvent(type="delta", text="creaks open")
            raise ValueError("a chunk that is not an object")

    monkeypatch.setattr("app.services.chat_service.get_provider", Breaks)
    convo = await setup_conversation(client)

    outcome = await send(client, convo["id"], content="Knock")

    assert outcome["kind"] == "internal"
    assert "not an object" in outcome["message"]
    reply = (await messages_of(client, convo["id"]))[-1]
    assert reply["content"] == "The door creaks open"
    assert reply["meta"].get("interrupted") == [0]


async def active_label(client, convo_id):
    """The version on screen, and whether the page labels it: what is read from the
    marks is in frontend/src/lib/cutShort.ts."""
    reply = (await messages_of(client, convo_id))[-1]
    marks = reply["meta"].get("interrupted")
    return reply["content"], marks is True or (isinstance(marks, list) and reply["active_index"] in marks)


async def swipe(client, convo_id, index):
    reply = (await messages_of(client, convo_id))[-1]
    resp = await client.patch(f"/api/messages/{reply['id']}", json={"active_index": index})
    assert resp.status_code == 200, resp.text


async def test_a_whole_regeneration_leaves_the_label_on_the_version_that_was_cut(client, provider):
    convo = await setup_conversation(client)
    provider.script = FAILS_AFTER_TWO_WORDS
    await send(client, convo["id"], content="Knock")
    provider.script = [ProviderEvent(type="delta", text="Whole."), ProviderEvent(type="done")]

    await send(client, convo["id"], content=None, mode="regenerate")

    assert await active_label(client, convo["id"]) == ("Whole.", False)
    await swipe(client, convo["id"], 0)
    assert await active_label(client, convo["id"]) == ("The door creaks open", True)


async def test_a_branch_keeps_which_version_was_cut_short(client, provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="Knock")
    provider.script = FAILS_AFTER_TWO_WORDS
    await send(client, convo["id"], content=None, mode="regenerate")
    reply = (await messages_of(client, convo["id"]))[-1]

    branch = (await client.post(f"/api/messages/{reply['id']}/branch")).json()

    assert branch["messages"][-1]["meta"].get("interrupted") == [1]
    assert branch["messages"][-1]["variants"] == ["Complete.", "The door creaks open"]
    assert await active_label(client, branch["id"]) == ("The door creaks open", True)
    await swipe(client, branch["id"], 0)
    assert await active_label(client, branch["id"]) == ("Complete.", False)
