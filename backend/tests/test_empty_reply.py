"""A model that answers nothing at all, and the one retry that saves it.

Several popular roleplay finetunes ship a chat template that refuses a
conversation whose first message is the assistant's. They stream zero tokens, or
an error inside a stream already begun. Evermind opens a conversation on the
character's greeting when it has one, so on those models the first message of a first conversation
dies in silence, which reads as "this application is broken" rather than "this
model is picky".
"""

import json
from typing import ClassVar

import httpx
import pytest

from app.prompting.engine import build_chat_payload
from app.providers.base import ProviderEvent
from tests.test_chat import parse_sse, setup_conversation
from tests.test_prompting import PERSONA, make_character, make_connection, make_message
from tests.test_providers import oai_provider, sse


def build(messages, **kwargs):
    return build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=messages, connection=make_connection(), **kwargs,
    )


GREETING = make_message("assistant", "*She looks up.* You came.", 0)
ASKED = make_message("user", "I did.", 1)


def test_leading_assistant_turn_moves_into_the_system_prompt():
    payload = build([GREETING, ASKED], fold_leading_assistant=True)

    assert payload.messages[0]["role"] == "user"
    assert payload.stats["leading_assistant_folded"] == 1
    assert "You came." in payload.system
    assert not any(m["content"] == "*She looks up.* You came." for m in payload.messages)


def test_every_leading_assistant_turn_folds_not_only_the_first():
    messages = [
        make_message("assistant", "First line.", 0),
        make_message("assistant", "Second line.", 1),
        make_message("user", "Right.", 2),
    ]
    payload = build(messages, fold_leading_assistant=True)

    assert [m["role"] for m in payload.messages] == ["user"]
    assert payload.stats["leading_assistant_folded"] == 2
    assert "First line." in payload.system
    assert "Second line." in payload.system


def test_folding_never_empties_the_message_list():
    """Sending no messages at all would trade one failure for a worse one."""
    payload = build([GREETING], fold_leading_assistant=True)

    assert payload.messages, "an assistant-only history must be left alone"
    assert payload.stats["leading_assistant_folded"] == 0


def test_nothing_folds_unless_asked():
    payload = build([GREETING, ASKED])

    assert payload.messages[0]["role"] == "assistant"
    assert payload.stats["leading_assistant_folded"] == 0


def test_folding_leaves_a_user_led_conversation_untouched():
    messages = [ASKED, make_message("assistant", "So you did.", 2)]
    payload = build(messages, fold_leading_assistant=True)

    assert payload.stats["leading_assistant_folded"] == 0
    assert [m["role"] for m in payload.messages] == ["user", "assistant"]


class ScriptedProvider:
    """Answers differently on each call and records the payloads it was given."""

    payloads: ClassVar[list] = []
    scripts: ClassVar[list] = []

    def __init__(self, connection):
        self.connection = connection

    async def stream_chat(self, payload):
        ScriptedProvider.payloads.append(payload)
        index = min(len(ScriptedProvider.payloads) - 1, len(ScriptedProvider.scripts) - 1)
        for event in ScriptedProvider.scripts[index]:
            yield event


SILENCE = [ProviderEvent(type="done")]


def speech(text):
    return [ProviderEvent(type="delta", text=text), ProviderEvent(type="done")]


@pytest.fixture()
def scripted(monkeypatch):
    ScriptedProvider.payloads = []
    ScriptedProvider.scripts = [SILENCE]
    monkeypatch.setattr("app.services.chat_service.get_provider", ScriptedProvider)
    monkeypatch.setattr("app.services.memory_service.get_provider", ScriptedProvider)
    return ScriptedProvider


async def send(client, convo_id, content="Hello there"):
    resp = await client.post("/api/chat", json={
        "conversation_id": convo_id, "mode": "send", "content": content,
    })
    assert resp.status_code == 200, resp.text
    return parse_sse(resp.text)


async def test_silence_is_retried_once_with_the_greeting_folded(client, scripted):
    scripted.scripts = [SILENCE, speech("She answers after all.")]
    convo = await setup_conversation(client)

    events = await send(client, convo["id"])

    assert len(scripted.payloads) == 2, "one silent answer should buy exactly one retry"
    assert scripted.payloads[0].messages[0]["role"] == "assistant"
    assert scripted.payloads[1].messages[0]["role"] == "user"
    assert scripted.payloads[1].stats["leading_assistant_folded"] == 1
    assert events[-1]["type"] == "done"
    assert events[-1]["message"]["content"] == "She answers after all."


async def test_a_model_that_answers_is_only_asked_once(client, scripted):
    scripted.scripts = [speech("Of course I answer.")]
    convo = await setup_conversation(client)

    await send(client, convo["id"])

    assert len(scripted.payloads) == 1, "a working model must not pay for the retry"


async def test_silence_twice_says_what_was_actually_tried(client, scripted):
    scripted.scripts = [SILENCE, SILENCE]
    convo = await setup_conversation(client)

    events = await send(client, convo["id"])

    assert len(scripted.payloads) == 2
    assert events[-1]["type"] == "error"
    message = events[-1]["message"]
    assert "twice" in message
    assert "chat template" in message, "the message has to name the likely cause"


async def test_the_retry_reply_is_the_one_that_gets_stored(client, scripted):
    scripted.scripts = [SILENCE, speech("Saved from the second pass.")]
    convo = await setup_conversation(client)
    await send(client, convo["id"])

    messages = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]

    assert [m["role"] for m in messages] == ["assistant", "user", "assistant"]
    assert messages[-1]["content"] == "Saved from the second pass."


@pytest.mark.parametrize(("status", "openings", "last"), [
    (200, ["assistant", "user"], "done"),
    (400, ["assistant"], "error"),
])
async def test_a_refusal_inside_the_stream_is_retried_and_an_error_status_is_not(
        client, monkeypatch, status, openings, last):
    """A template may refuse the greeting with an error in a stream it has already begun."""
    refusal = json.dumps({"error": {"message": "Error rendering prompt with jinja template: "
                                               "roles must alternate"}})
    asked = []

    def server(request: httpx.Request) -> httpx.Response:
        asked.append(json.loads(request.content)["messages"][1]["role"])
        if asked[-1] == "user":
            return httpx.Response(200, content=sse([json.dumps(
                {"choices": [{"delta": {"content": "She answers."}}]}), "[DONE]"]))
        return httpx.Response(status, content=sse([refusal]) if status == 200 else refusal)

    for module in ("chat_service", "memory_service"):
        monkeypatch.setattr(f"app.services.{module}.get_provider",
                            lambda connection: oai_provider(server))
    convo = await setup_conversation(client)

    events = await send(client, convo["id"])

    assert asked == openings
    assert events[-1]["type"] == last


async def test_a_refusal_with_no_greeting_to_blame_is_the_error_the_server_gave(
        client, monkeypatch):
    refusal = json.dumps({"error": {"message": "Error rendering prompt with jinja template"}})
    asked = []

    def server(request: httpx.Request) -> httpx.Response:
        asked.append(request)
        return httpx.Response(200, content=sse([refusal]))

    for module in ("chat_service", "memory_service"):
        monkeypatch.setattr(f"app.services.{module}.get_provider",
                            lambda connection: oai_provider(server))
    convo = await setup_conversation(client, greeting="")

    events = await send(client, convo["id"])

    assert len(asked) == 1
    assert events[-1]["kind"] == "model_error"
