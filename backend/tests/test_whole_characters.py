"""A character a model's server splits across two events.

Some servers write each token as JSON on its own, so an emoji can leave in two halves:
"\\ud83d" closes one event and "\\ude00" opens the next. Each event is read on its own,
and the two halves only make a character again once they are put back together. Model
text leaves the providers whole: a pair split across events is joined, a half that never
finds its pair is U+FFFD, and a high half the model never followed up is dropped.
"""

import asyncio
import json

import httpx
import pytest

from app.errors import MODEL_ERROR
from app.providers import complete
from app.providers.anthropic import AnthropicProvider
from app.providers.base import CONNECTION_LOST
from app.providers.openai_compat import OpenAICompatProvider
from app.services import card_assistant

from .conftest import (
    ANTH_CONN,
    OAI_CONN,
    PAYLOAD,
    messages_of,
    send,
    setup_conversation,
    sse,
    stored_facts,
    within,
)

HIGH, LOW = "\ud83d", "\ude00"  # the two halves of U+1F600
SMILE = "\U0001f600"


def halves(text: str) -> tuple[str, str]:
    """The text cut in the middle of its first character outside the basic plane."""
    at = next(i for i, ch in enumerate(text) if ord(ch) > 0xFFFF)
    units = text[at].encode("utf-16-le")
    high, low = (units[i:i + 2].decode("utf-16-le", "surrogatepass") for i in (0, 2))
    return text[:at] + high, low + text[at + 1:]


def oai_body(pieces) -> bytes:
    def event(kind, text):
        key = "content" if kind == "reply" else "reasoning_content"
        return json.dumps({"choices": [{"delta": {key: text}}]})

    return sse([event(kind, text) for kind, text in pieces] + ["[DONE]"])


def anth_body(pieces) -> bytes:
    def event(kind, text):
        delta = ({"type": "text_delta", "text": text} if kind == "reply"
                 else {"type": "thinking_delta", "thinking": text})
        return {"type": "content_block_delta", "delta": delta}

    events = [event(kind, text) for kind, text in pieces] + [{"type": "message_stop"}]
    return b"".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n".encode() for e in events)


ADAPTERS = {
    "openai": (OpenAICompatProvider, OAI_CONN, oai_body),
    "anthropic": (AnthropicProvider, ANTH_CONN, anth_body),
}


def serving(adapter: str, body: bytes | httpx.AsyncByteStream):
    """The real provider of that kind, as built for a connection, over a server that sends this."""
    provider_class, _, _ = ADAPTERS[adapter]

    def make(connection):
        provider = provider_class(connection)
        response = (lambda _: httpx.Response(200, content=body)) if isinstance(body, bytes) \
            else (lambda _: httpx.Response(200, stream=body))
        provider._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(response))
        return provider

    return make


def replying(*texts: str, adapter="openai"):
    return serving(adapter, ADAPTERS[adapter][2]([("reply", text) for text in texts]))


async def what_leaves(adapter: str, pieces) -> list[tuple[str, str | int]]:
    _, connection, body = ADAPTERS[adapter]
    provider = serving(adapter, body(pieces))(connection)
    return [(e.type, e.text if e.type == "delta" else e.count)
            async for e in provider.stream_chat(PAYLOAD) if e.type != "done"]


R, T = "reply", "thinking"

JOINING = {
    "a pair across two deltas":
        ([(R, "Hi " + HIGH), (R, LOW + " there.")], [("delta", "Hi "), ("delta", SMILE + " there.")]),
    "a pair across three, with an empty delta between":
        ([(R, "a" + HIGH), (R, ""), (R, LOW + "b")], [("delta", "a"), ("delta", SMILE + "b")]),
    "a lone high in the middle of a delta":
        ([(R, "a" + HIGH + "b")], [("delta", "a�b")]),
    "a lone high at the end of a delta, not followed by its low":
        ([(R, "a" + HIGH), (R, "b")], [("delta", "a"), ("delta", "�b")]),
    "a lone low at the start":
        ([(R, LOW + "a")], [("delta", "�a")]),
    "two highs in a row":
        ([(R, HIGH), (R, HIGH), (R, LOW)], [("delta", "�"), ("delta", SMILE)]),
    "a high at the very end is dropped":
        ([(R, "Bye " + HIGH)], [("delta", "Bye ")]),
    "ordinary text is untouched":
        ([(R, "Hel"), (R, "lo ü 中 " + SMILE)], [("delta", "Hel"), ("delta", "lo ü 中 " + SMILE)]),
    "reply and thinking are joined apart":
        ([(T, "x" + HIGH), (R, LOW + "y"), (T, LOW), (R, "z")],
         [("thought", 1), ("delta", "�y"), ("thought", 1), ("delta", "z")]),
    "thinking alone":
        ([(T, "Plan" + HIGH), (T, LOW), (R, "Hi")], [("thought", 4), ("thought", 1), ("delta", "Hi")]),
}


@pytest.mark.parametrize("adapter", list(ADAPTERS))
@pytest.mark.parametrize(("pieces", "given"), list(JOINING.values()), ids=list(JOINING))
async def test_model_text_leaves_the_provider_whole(adapter, pieces, given):
    assert await what_leaves(adapter, pieces) == given


@pytest.mark.parametrize("adapter", list(ADAPTERS))
async def test_a_whole_answer_joins_the_halves_too(adapter):
    _, connection, _ = ADAPTERS[adapter]
    provider = replying(*halves(f"Hi {SMILE} there."), adapter=adapter)(connection)
    assert await complete(provider, PAYLOAD) == f"Hi {SMILE} there."


class Held(httpx.AsyncByteStream):
    """Some events, then nothing until it is closed."""

    def __init__(self, *texts: str):
        self.texts = texts

    async def __aiter__(self):
        yield sse([json.dumps({"choices": [{"delta": {"content": t}}]}) for t in self.texts])
        await asyncio.Event().wait()


async def test_ordinary_text_is_given_as_soon_as_it_arrives():
    stream = serving("openai", Held("Hel"))(OAI_CONN).stream_chat(PAYLOAD)
    assert (await within(1, anext(stream))).text == "Hel"
    await stream.aclose()


async def test_only_a_trailing_high_half_waits_for_what_follows():
    stream = serving("openai", Held("Hi " + HIGH))(OAI_CONN).stream_chat(PAYLOAD)
    assert (await within(1, anext(stream))).text == "Hi "
    await stream.aclose()


class CutAfter(httpx.AsyncByteStream):
    """Some events, then the connection breaks."""

    def __init__(self, *texts: str):
        self.texts = texts

    async def __aiter__(self):
        yield sse([json.dumps({"choices": [{"delta": {"content": t}}]}) for t in self.texts])
        raise httpx.ReadError("The connection broke.")


@pytest.fixture()
def chat_model(monkeypatch):
    def use(make):
        monkeypatch.setattr("app.services.chat_service.get_provider", make)
        monkeypatch.setattr("app.services.memory_service.get_provider", make)
    return use


async def test_a_reply_split_inside_an_emoji_is_saved_whole(client, chat_model):
    convo = await setup_conversation(client)
    chat_model(replying(*halves(f"Hi {SMILE} there.")))

    outcome = await send(client, convo["id"], content="Hello")

    assert outcome is None
    assert (await messages_of(client, convo["id"]))[-1]["content"] == f"Hi {SMILE} there."


async def test_a_reply_ending_on_half_an_emoji_is_saved_without_it(client, chat_model):
    convo = await setup_conversation(client)
    chat_model(replying("Bye " + HIGH))

    assert await send(client, convo["id"], content="Hello") is None
    reply = (await messages_of(client, convo["id"]))[-1]
    assert (reply["role"], reply["content"].strip()) == ("assistant", "Bye")


async def test_a_reply_cut_right_after_half_an_emoji_keeps_what_arrived(client, chat_model):
    convo = await setup_conversation(client)
    chat_model(serving("openai", CutAfter("The door ", "creaks " + HIGH)))

    outcome = await send(client, convo["id"], content="Knock")

    assert outcome["kind"] == CONNECTION_LOST
    reply = (await messages_of(client, convo["id"]))[-1]
    assert (reply["role"], reply["content"]) == ("assistant", "The door creaks")


async def test_the_memory_pass_keeps_a_fact_split_inside_an_emoji(client, chat_model):
    convo = await setup_conversation(client)
    chat_model(replying("Hello."))
    await send(client, convo["id"])
    fact = f"Serana keeps a {SMILE} drawn on her crypt."
    chat_model(replying(*halves(json.dumps({"facts": [{"content": fact}], "summary": "A visit."},
                                           ensure_ascii=False))))

    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")

    assert resp.status_code == 200, resp.text
    assert [content for content, *_ in await stored_facts(client, convo["id"])] == [fact]


def refusing(words: str):
    """An OpenAI-compatible server that refuses the request with these words."""
    def make(connection):
        provider = OpenAICompatProvider(connection)
        body = json.dumps({"error": {"message": words}}).encode()
        provider._client_factory = lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(400, content=body)))
        return provider
    return make


async def test_a_refusal_with_half_an_emoji_in_its_words_is_told(client, chat_model):
    convo = await setup_conversation(client)
    chat_model(refusing("Bad request " + HIGH))

    outcome = await send(client, convo["id"], content="Hello")

    assert (outcome["kind"], outcome["message"]) == (MODEL_ERROR, "Bad request �")


ERROR_EVENTS = {
    "openai": lambda words: sse([json.dumps({"choices": [{"delta": {"content": "Hi"}}]}),
                                 json.dumps({"error": {"message": words}})]),
    "anthropic": lambda words: b"".join(
        f"event: {e['type']}\ndata: {json.dumps(e)}\n\n".encode() for e in [
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hi"}},
            {"type": "error", "error": {"type": "overloaded_error", "message": words}}]),
}


@pytest.mark.parametrize("adapter", list(ADAPTERS))
async def test_an_error_event_with_half_an_emoji_in_its_words_is_told(client, chat_model, adapter):
    convo = await setup_conversation(client)
    chat_model(serving(adapter, ERROR_EVENTS[adapter]("Overloaded " + HIGH)))

    outcome = await send(client, convo["id"], content="Hello")

    assert (outcome["kind"], outcome["message"]) == (MODEL_ERROR, "Overloaded �")
    reply = (await messages_of(client, convo["id"]))[-1]
    assert (reply["role"], reply["content"]) == ("assistant", "Hi")


async def test_the_card_assistant_keeps_a_name_split_inside_an_emoji(client, monkeypatch):
    await client.post("/api/connections", json={
        "name": "Mock", "provider": "openai-compatible",
        "base_url": "http://localhost:1234/v1", "model": "test"})
    name = f"Nyra {SMILE}"
    card = json.dumps({"name": name, "description": "A cartographer."}, ensure_ascii=False)
    monkeypatch.setattr("app.services.card_assistant.get_provider", replying(*halves(card)))

    resp = await client.post("/api/characters/assist", json={"prompt": "A cartographer"})
    assert resp.status_code == 202, resp.text
    await within(2, card_assistant._jobs[resp.json()["id"]].finished.wait())
    state = (await client.get(f"/api/characters/assist/{resp.json()['id']}")).json()

    assert state["error"] is None
    assert state["draft"]["name"] == name
