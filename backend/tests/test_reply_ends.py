"""An answer with nothing written, or a reply cut by its ceiling, says why wherever a model is asked.

A model that reasons before it writes can spend the whole of a connection's max tokens thinking,
and a server can withhold an answer and say so in its stop word. "The model returned an empty
reply" tells the person neither, and asking again with the same room only costs more."""

import asyncio
from typing import ClassVar

import pytest

from app.errors import MODEL_EMPTY, MODEL_ONLY_THOUGHT, MODEL_WITHHELD, error_body
from app.models.schemas import ChatRequest
from app.providers.base import NO_TEXT, Answer, ProviderError, ProviderEvent, unwritten
from app.services import turns

from .conftest import assist, messages_of, send, setup_conversation
from .helpers import add_model, set_ai


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


def test_an_only_thought_answer_points_to_this_ai_s_ceiling_not_a_connection():
    message = unwritten(Answer("", 500, "length")).message
    assert "this AI's reply ceiling" in message and "connection" not in message


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
            if isinstance(event, Exception):
                raise event
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


# A reply with words that stopped for length: cut by the connection's ceiling, not by anyone.

async def with_ceiling(client, max_tokens=1024):
    convo = await setup_conversation(client)
    await set_ai(client, max_tokens=max_tokens)
    return convo


async def last_reply(client, convo) -> dict:
    return (await messages_of(client, convo["id"]))[-1]


async def test_a_reply_cut_by_its_ceiling_is_kept_and_says_so(client, model):
    model.scripts = [ends("She opens her mouth to", thought=3000, stop="length")]
    convo = await with_ceiling(client)

    assert await send(client, convo["id"]) is None
    reply = await last_reply(client, convo)
    assert reply["content"] == "She opens her mouth to"
    # Told apart from a version someone stopped: the interface says why it is cut.
    assert reply["meta"]["ceiling"] == {"0": 1024}
    assert "interrupted" not in reply["meta"]
    assert "perf" in reply["meta"]


async def test_a_ceiling_the_connection_does_not_set_is_marked_without_a_number(client, model):
    model.scripts = [ends("She opens her mouth to", stop="length")]
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    assert (await last_reply(client, convo))["meta"]["ceiling"] == {"0": None}


async def test_a_reply_that_ends_on_its_own_has_no_mark(client, model):
    convo = await with_ceiling(client)
    await send(client, convo["id"])
    assert "ceiling" not in (await last_reply(client, convo))["meta"]


async def test_continuing_a_cut_reply_to_its_end_clears_the_mark(client, model):
    model.scripts = [ends("She opens her mouth to", stop="length"), ends("speak.", stop="stop")]
    convo = await with_ceiling(client)
    await send(client, convo["id"])

    assert await send(client, convo["id"], content=None, mode="continue") is None
    reply = await last_reply(client, convo)
    assert reply["content"] == "She opens her mouth to speak."
    assert "ceiling" not in reply["meta"]


async def test_a_continuation_cut_again_keeps_the_mark(client, model):
    model.scripts = [ends("She opens", stop="length"), ends("her mouth", stop="length")]
    convo = await with_ceiling(client)
    await send(client, convo["id"])
    await send(client, convo["id"], content=None, mode="continue")
    assert (await last_reply(client, convo))["meta"]["ceiling"] == {"0": 1024}


async def test_a_continuation_a_failure_cut_is_marked_as_cut_short_instead(client, model):
    model.scripts = [ends("She opens", stop="length"),
                     [ProviderEvent(type="delta", text="her mouth"), ProviderError("gone")]]
    convo = await with_ceiling(client)
    await send(client, convo["id"])
    await send(client, convo["id"], content=None, mode="continue")
    reply = await last_reply(client, convo)
    assert reply["meta"]["interrupted"] == [0]
    assert "ceiling" not in reply["meta"]


async def test_a_reply_a_failure_cut_after_its_end_is_cut_short_not_at_its_ceiling(client, model):
    model.scripts = [[*ends("She opens", stop="length"), ProviderError("gone")]]
    convo = await with_ceiling(client)
    await send(client, convo["id"])
    reply = await last_reply(client, convo)
    assert reply["meta"]["interrupted"] == [0]
    assert "ceiling" not in reply["meta"]


class EndsThenLingers:
    """A reply that stops for length, after which its stream stays open until the turn is stopped."""

    ended: asyncio.Event

    def __init__(self, connection):
        self.connection = connection

    async def stream_chat(self, payload):
        for event in ends("She opens", stop="length"):
            yield event
        EndsThenLingers.ended.set()
        await asyncio.sleep(60)


async def test_a_reply_the_person_stopped_is_not_said_to_be_cut_at_its_ceiling(
        client, model, monkeypatch):
    """Its model had already said it ran out, but the person stopped it: what shows is theirs."""
    convo = await with_ceiling(client)
    EndsThenLingers.ended = asyncio.Event()
    monkeypatch.setattr("app.services.chat_service.get_provider", EndsThenLingers)
    turn = await turns.start(ChatRequest(conversation_id=convo["id"], mode="send",
                                         content="Go on", client_id="stopped"))
    await asyncio.wait_for(EndsThenLingers.ended.wait(), timeout=10)
    await turns.stop(convo["id"])
    await asyncio.wait_for(turn.finished.wait(), timeout=15)

    reply = await last_reply(client, convo)
    assert reply["content"] == "She opens"
    assert reply["meta"]["interrupted"] == [0]
    assert "ceiling" not in reply["meta"]


async def test_an_anthropic_ceiling_left_unset_is_marked_with_the_one_sent(client, model):
    """Anthropic's API needs a max_tokens: with none in the connection, Evermind sends its own,
    and that is what cut the reply, not a limit of the server's."""
    model.scripts = [ends("She opens her mouth to", stop="length")]
    convo = await setup_conversation(client)
    await set_ai(client, provider="anthropic", max_tokens=None)
    await send(client, convo["id"])
    assert (await last_reply(client, convo))["meta"]["ceiling"] == {"0": 4096}


async def test_a_continuation_that_adds_nothing_leaves_the_mark(client, model):
    model.scripts = [ends("She opens", stop="length"), ends(stop="content_filter")]
    convo = await with_ceiling(client)
    await send(client, convo["id"])
    await send(client, convo["id"], content=None, mode="continue")
    assert (await last_reply(client, convo))["meta"]["ceiling"] == {"0": 1024}


async def test_a_new_version_has_its_own_mark_and_the_cut_one_keeps_its_own(client, model):
    model.scripts = [ends("She opens", stop="length"), ends("She nods.", stop="stop"),
                     ends("She sighs and", stop="length")]
    convo = await with_ceiling(client)
    await send(client, convo["id"])

    await send(client, convo["id"], content=None, mode="regenerate")
    assert (await last_reply(client, convo))["meta"]["ceiling"] == {"0": 1024}
    await send(client, convo["id"], content=None, mode="regenerate")
    assert (await last_reply(client, convo))["meta"]["ceiling"] == {"0": 1024, "2": 1024}


async def test_rewriting_a_cut_version_by_hand_clears_its_mark_and_a_swipe_does_not(client, model):
    model.scripts = [ends("She opens", stop="length"), ends("She nods", stop="length")]
    convo = await with_ceiling(client)
    await send(client, convo["id"])
    await send(client, convo["id"], content=None, mode="regenerate")
    reply = await last_reply(client, convo)

    swiped = (await client.patch(f"/api/messages/{reply['id']}", json={"active_index": 0})).json()
    assert swiped["meta"]["ceiling"] == {"0": 1024, "1": 1024}
    edited = (await client.patch(f"/api/messages/{reply['id']}",
                                 json={"content": "She opens the door.", "active_index": 0})).json()
    assert edited["meta"]["ceiling"] == {"1": 1024}
    edited = (await client.patch(f"/api/messages/{reply['id']}",
                                 json={"content": "She nods.", "active_index": 1})).json()
    assert "ceiling" not in edited["meta"]


# Every other place that asks a model.

WITHHELD = {"error": "The model's server withheld the answer (\"content_filter\").",
            "kind": MODEL_WITHHELD, "reason": "content_filter"}


@pytest.mark.parametrize(("script", "kind"), [
    (ends(thought=8000, stop="length"), MODEL_ONLY_THOUGHT),
    (ends(stop="content_filter"), MODEL_WITHHELD),
    (ends(stop="stop"), MODEL_EMPTY),
])
async def test_a_ghost_written_message_with_nothing_in_it_says_why(client, model, script, kind):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    model.scripts = [script]

    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")

    assert resp.status_code == 502
    assert resp.json()["kind"] == kind
    if kind == MODEL_WITHHELD:
        assert resp.json() == WITHHELD


@pytest.mark.parametrize(("script", "kind"), [
    (ends(thought=8000, stop="length"), MODEL_ONLY_THOUGHT),
    (ends(stop="content_filter"), MODEL_WITHHELD),
    (ends(stop="stop"), NO_TEXT),
])
async def test_a_connection_test_that_produced_nothing_says_why(client, model, monkeypatch,
                                                               script, kind):
    monkeypatch.setattr("app.routers.models.get_provider", Scripted)
    model.scripts = [script]
    ai = await add_model(client, base_url="http://mock/v1", model="test-model")

    resp = await client.post(f"/api/models/{ai['id']}/benchmark")

    assert resp.status_code == 502
    assert resp.json()["kind"] == kind
    if kind == MODEL_WITHHELD:
        assert resp.json() == WITHHELD


async def test_a_connection_test_that_reasons_then_writes_measures_from_the_first_word(
        client, model, monkeypatch):
    monkeypatch.setattr("app.routers.models.get_provider", Scripted)
    model.scripts = [ends("Rain on a quiet street.", thought=500, stop="stop")]
    ai = await add_model(client, base_url="http://mock/v1", model="test-model")
    resp = await client.post(f"/api/models/{ai['id']}/benchmark")
    assert resp.status_code == 200, resp.text
    assert resp.json()["tokens"] > 0


async def test_a_card_the_server_withheld_names_its_word(client, model, monkeypatch):
    monkeypatch.setattr("app.services.card_assistant.get_provider", Scripted)
    await setup_conversation(client)
    model.scripts = [ends(stop="content_filter")]
    state = await assist(client)
    assert state["error"] == WITHHELD
