"""An answer with nothing written, or a reply cut by its ceiling, says why wherever a model is asked.

A model that reasons before it writes can spend the whole of a connection's max tokens thinking,
and a server can withhold an answer and say so in its stop word. "The model returned an empty
reply" tells the person neither, and asking again with the same room only costs more."""

from typing import ClassVar

import pytest

from app.errors import MODEL_EMPTY, MODEL_ONLY_THOUGHT, MODEL_WITHHELD, error_body
from app.providers.base import Answer, ProviderEvent, unwritten

from .conftest import messages_of, send, setup_conversation


@pytest.mark.parametrize(("answer", "kind", "reason"), [
    (Answer("", 74605, "length"), MODEL_ONLY_THOUGHT, None),
    (Answer("", 500, "stop"), MODEL_ONLY_THOUGHT, None),
    (Answer("", 0, "length"), MODEL_ONLY_THOUGHT, None),
    (Answer("  \n", 0, "content_filter"), MODEL_WITHHELD, "content_filter"),
    (Answer("", 0, "refusal"), MODEL_WITHHELD, "refusal"),
])
def test_an_answer_with_nothing_written_says_why_when_how_it_ended_tells(answer, kind, reason):
    error = unwritten(answer)
    assert error.kind == kind
    assert error.status_code == 502
    assert error_body(error).get("reason") == reason


def test_the_server_s_own_word_is_quoted():
    error = unwritten(Answer("", 0, "content_filter"))
    assert error.message == 'The model\'s server withheld the answer ("content_filter").'
    assert error_body(error) == {"error": error.message, "kind": MODEL_WITHHELD,
                                 "reason": "content_filter"}


@pytest.mark.parametrize("answer", [
    Answer("", 0, None), Answer("", 0, "stop"), Answer("", 0, "end_turn"),
    Answer("", 0, "stop_sequence"), Answer("Some words.", 900, "length"),
    Answer("Some words.", 0, "content_filter"),
])
def test_an_answer_with_no_clue_or_with_words_is_left_to_its_caller(answer):
    assert unwritten(answer) is None


def test_only_thought_can_be_worded_by_its_caller():
    error = unwritten(Answer("", 10, "length"), only_thought="No memory written.")
    assert (error.kind, error.message) == (MODEL_ONLY_THOUGHT, "No memory written.")


# The conversation turn.

class Scripted:
    """A model that gives each request the next scripted answer, and counts the requests."""

    scripts: ClassVar[list] = []
    asked: ClassVar[int] = 0

    def __init__(self, connection):
        self.connection = connection

    async def stream_chat(self, payload):
        Scripted.asked += 1
        for event in Scripted.scripts[min(Scripted.asked, len(Scripted.scripts)) - 1]:
            yield event


def ends(text="", thought=0, stop=None) -> list[ProviderEvent]:
    events = [ProviderEvent(type="thought", count=thought)] if thought else []
    if text:
        events.append(ProviderEvent(type="delta", text=text))
    return [*events, ProviderEvent(type="done", stop=stop)]


@pytest.fixture()
def model(monkeypatch):
    Scripted.scripts, Scripted.asked = [ends("She waits.", stop="stop")], 0
    monkeypatch.setattr("app.services.chat_service.get_provider", Scripted)
    monkeypatch.setattr("app.services.memory_service.get_provider", Scripted)
    return Scripted


async def test_a_reply_that_only_thought_says_so_and_is_not_asked_again(client, model):
    """The greeting folded in is for a template that refuses it in silence: a model that thought
    through all its room would only think through it again, and every token is paid for."""
    model.scripts = [ends(thought=74605, stop="length"), ends("Never asked for.")]
    convo = await setup_conversation(client)

    outcome = await send(client, convo["id"])

    assert model.asked == 1
    assert outcome["kind"] == MODEL_ONLY_THOUGHT
    unanswered = (await messages_of(client, convo["id"]))[-1]["meta"]["unanswered"]
    assert unanswered["kind"] == MODEL_ONLY_THOUGHT


async def test_a_reply_cut_for_length_before_a_word_is_not_asked_again(client, model):
    model.scripts = [ends(stop="length"), ends("Never asked for.")]
    convo = await setup_conversation(client)
    assert (await send(client, convo["id"]))["kind"] == MODEL_ONLY_THOUGHT
    assert model.asked == 1


async def test_a_reply_the_server_withheld_names_its_word(client, model):
    model.scripts = [ends(stop="content_filter")]
    convo = await setup_conversation(client)

    outcome = await send(client, convo["id"])

    assert outcome == {"kind": MODEL_WITHHELD, "reason": "content_filter", "mode": "send",
                       "message": 'The model\'s server withheld the answer ("content_filter").'}
    assert model.asked == 1
    unanswered = (await messages_of(client, convo["id"]))[-1]["meta"]["unanswered"]
    assert unanswered["reason"] == "content_filter"


async def test_silence_with_no_clue_is_still_an_empty_reply_after_one_retry(client, model):
    model.scripts = [ends(stop="stop"), ends(stop="stop")]
    convo = await setup_conversation(client)
    assert (await send(client, convo["id"]))["kind"] == MODEL_EMPTY
    assert model.asked == 2


async def test_a_continuation_that_only_thought_says_so_and_not_nothing_to_add(client, model):
    model.scripts = [ends("She waits.", stop="stop"), ends(thought=9000, stop="length")]
    convo = await setup_conversation(client)
    await send(client, convo["id"])

    outcome = await send(client, convo["id"], content=None, mode="continue")

    assert (outcome["kind"], outcome["mode"]) == (MODEL_ONLY_THOUGHT, "continue")
    assert (await messages_of(client, convo["id"]))[-1]["variants"] == ["She waits."]


async def test_a_continuation_the_server_withheld_names_its_word(client, model):
    model.scripts = [ends("She waits.", stop="stop"), ends(stop="content_filter")]
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    outcome = await send(client, convo["id"], content=None, mode="continue")
    assert (outcome["kind"], outcome["reason"]) == (MODEL_WITHHELD, "content_filter")


async def test_a_continuation_with_no_clue_still_has_nothing_to_add(client, model):
    model.scripts = [ends("She waits.", stop="stop"), ends(stop="stop")]
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    outcome = await send(client, convo["id"], content=None, mode="continue")
    assert outcome["kind"] == "nothing_added"
