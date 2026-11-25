"""What a model's server says of each call, kept on the provider as it arrives.

Every provider hands back the server's own figures (its counts, the id it gave the generation,
the model and host that served it, why it stopped), whatever becomes of the reply: a stop or an
error leaves what came readable. An OpenAI-compatible server is asked for its counts with
``stream_options``; one that refuses the field is asked again without it, and not told again
until the next start.

The streams below are written by hand in the shapes the servers document.
"""

import asyncio
import json
import logging

import httpx
import pytest

from app.providers import (
    CallFigures,
    ProviderError,
    complete,
    complete_answer,
    get_provider,
    openai_compat,
)
from app.providers.anthropic import AnthropicProvider
from app.providers.base import CONNECTION_LOST, RATE_LIMITED, UNREACHABLE
from app.providers.openai_compat import OpenAICompatProvider

from .conftest import ANTH_CONN, OAI_CONN, PAYLOAD, send, setup_conversation, sse, within

USAGE = {"prompt_tokens": 1200, "completion_tokens": 340, "cost": 0.0021}


def serve(kind, handler, connection=None):
    """A provider whose requests reach ``handler`` and nothing else."""
    made = (AnthropicProvider if kind == "anthropic" else OpenAICompatProvider)(
        connection or (ANTH_CONN if kind == "anthropic" else OAI_CONN))
    made._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return made


def answering(*events, done=True):
    """A server that streams ``events`` and keeps the body of each request it is sent."""
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        lines = [json.dumps(event) for event in events] + (["[DONE]"] if done else [])
        return httpx.Response(200, content=sse(lines))
    return handler, bodies


def openrouter_chunk(**delta):
    return {"id": "gen-1", "model": "aurore/aurore-large", "provider": "Lumen",
            "choices": [{"delta": delta, "finish_reason": None}]}


OPENROUTER = [
    openrouter_chunk(reasoning="Let me "),
    openrouter_chunk(reasoning="think."),
    openrouter_chunk(content="*She "),
    openrouter_chunk(content="smiles"),
    openrouter_chunk(content=".*"),
    {"id": "gen-1", "model": "aurore/aurore-large", "provider": "Lumen",
     "choices": [{"delta": {}, "finish_reason": "stop"}]},
    {"id": "gen-1", "model": "aurore/aurore-large", "provider": "Lumen", "choices": [],
     "usage": USAGE},
]

ANTHROPIC = [
    {"type": "message_start", "message": {"id": "msg_1", "model": "lumen-1",
                                          "usage": {"input_tokens": 900, "output_tokens": 1}}},
    {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "Hmm, yes."}},
    {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "*She "}},
    {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "nods.*"}},
    {"type": "message_delta", "delta": {"stop_reason": "end_turn"},
     "usage": {"output_tokens": 210}},
    {"type": "message_stop"},
]


async def drain(provider):
    return [event async for event in provider.stream_chat(PAYLOAD)]


async def test_call_figures_are_filled_whole_on_each_provider():
    handler, _ = answering(*OPENROUTER)
    provider = serve("openai", handler)
    await drain(provider)
    figures = provider.figures
    assert isinstance(figures, CallFigures)
    assert figures.usage == USAGE
    assert (figures.generation_id, figures.model_served, figures.upstream, figures.stop) == (
        "gen-1", "aurore/aurore-large", "Lumen", "stop")
    assert figures.chars_out == len("*She smiles.*")
    assert figures.thought_chars == len("Let me think.")
    assert (figures.sent, figures.opened, figures.usage_final) == (True, True, True)
    assert figures.on_id is None

    handler, _ = answering(*ANTHROPIC, done=False)
    provider = serve("anthropic", handler)
    await drain(provider)
    figures = provider.figures
    assert figures.usage == {"input_tokens": 900, "output_tokens": 210}
    assert (figures.generation_id, figures.model_served, figures.upstream, figures.stop) == (
        "msg_1", "lumen-1", None, "end_turn")
    assert figures.chars_out == len("*She nods.*")
    assert figures.thought_chars == len("Hmm, yes.")
    assert (figures.sent, figures.opened, figures.usage_final) == (True, True, True)


async def test_a_count_given_as_null_never_erases_one():
    # Anthropic's last count may carry the input or cache counts as null: the first one stays.
    events = [*ANTHROPIC[:4], {"type": "message_delta", "delta": {"stop_reason": "end_turn"},
                               "usage": {"input_tokens": None, "output_tokens": 210}}]
    handler, _ = answering(*events, done=False)
    provider = serve("anthropic", handler)
    await drain(provider)
    assert provider.figures.usage == {"input_tokens": 900, "output_tokens": 210}
    assert provider.figures.usage_final


async def test_the_first_names_given_are_kept():
    later = {"id": "gen-2", "model": "aurore/aurore-small", "provider": "Other",
             "choices": [{"delta": {"content": "!"}, "finish_reason": "stop"}]}
    handler, _ = answering(*OPENROUTER[2:5], later)
    provider = serve("openai", handler)
    await drain(provider)
    figures = provider.figures
    assert (figures.generation_id, figures.model_served, figures.upstream) == (
        "gen-1", "aurore/aurore-large", "Lumen")


async def test_characters_are_counted_as_they_leave_whole():
    # An emoji split in two halves across two events is one character out, not two.
    handler, _ = answering(openrouter_chunk(content="Hi \ud83d"),
                           openrouter_chunk(content="\ude00!"))
    provider = serve("openai", handler)
    events = await drain(provider)
    text = "".join(e.text for e in events if e.type == "delta")
    assert text == "Hi \U0001f600!"
    assert provider.figures.chars_out == len(text) == 5


async def test_reasoning_characters_are_counted_as_they_leave_whole():
    # The reasoning is joined on its own before it is counted, as the reply is.
    handler, _ = answering(openrouter_chunk(reasoning="Hm \ud83d"),
                           openrouter_chunk(reasoning="\ude00"))
    provider = serve("openai", handler)
    events = await drain(provider)
    assert sum(e.count for e in events if e.type == "thought") == 4
    assert provider.figures.thought_chars == 4


async def test_anthropic_gives_its_stop_as_it_said_it():
    events = [*ANTHROPIC[:4], {"type": "message_delta", "delta": {"stop_reason": "max_tokens"},
                               "usage": {"output_tokens": 256}}]
    handler, _ = answering(*events, done=False)
    provider = serve("anthropic", handler)
    ended = (await drain(provider))[-1]
    assert ended.stop == "length"  # what the services read, as before
    assert provider.figures.stop == "max_tokens"


async def test_on_id_is_called_once_when_the_id_is_first_known():
    handler, _ = answering(*OPENROUTER[2:5])
    provider = serve("openai", handler)
    seen = []
    provider.figures.on_id = lambda figures: seen.append((figures, figures.generation_id))
    await drain(provider)
    assert seen == [(provider.figures, "gen-1")]

    provider = serve("openai", handler)
    assert provider.figures.on_id is None
    await drain(provider)  # nothing to call: nothing raises
    assert provider.figures.generation_id == "gen-1"


async def test_the_only_new_field_is_include_usage():
    before = {
        "model": "test-model",
        "messages": [{"role": "system", "content": "You are Serana."},
                     {"role": "assistant", "content": "*She stirs.*"},
                     {"role": "user", "content": "Hello\n\nStay tense."}],
        "stream": True,
        "max_tokens": 256, "temperature": 0.9, "top_p": 0.95,
        "frequency_penalty": 0.1, "presence_penalty": 0.1,
        "stop": ["\nAlex:"],
    }
    handler, bodies = answering(*OPENROUTER)
    await drain(serve("openai", handler))
    assert bodies == [{**before, "stream_options": {"include_usage": True}}]

    handler, bodies = answering(*ANTHROPIC, done=False)
    await drain(serve("anthropic", handler))
    assert "stream_options" not in bodies[0]
    assert not any("usage" in key for key in bodies[0])


def refusing_usage(message="Unrecognized request argument supplied: stream_options"):
    """A server that refuses any request carrying stream_options, as the older ones do."""
    bodies = []

    def handler(request):
        body = json.loads(request.content)
        bodies.append(body)
        if "stream_options" in body:
            return httpx.Response(400, json={"error": {"message": message}})
        return httpx.Response(200, content=sse([json.dumps(c) for c in OPENROUTER] + ["[DONE]"]))
    return handler, bodies


async def test_a_server_that_refuses_include_usage_is_asked_without_once_per_start(caplog):
    caplog.set_level(logging.INFO, logger="app.providers.openai_compat")
    service = dict(OAI_CONN, service_id="s-old")
    handler, bodies = refusing_usage()

    provider = serve("openai", handler, service)
    events = await drain(provider)
    assert "".join(e.text for e in events if e.type == "delta") == "*She smiles.*"
    assert ["stream_options" in body for body in bodies] == [True, False]
    # What the provider holds is the request that answered, not the one refused.
    assert (provider.figures.sent, provider.figures.opened) == (True, True)
    assert provider.figures.usage == USAGE
    told = [r for r in caplog.records if "stream_options" in r.getMessage()]
    assert len(told) == 1 and told[0].levelno == logging.INFO

    bodies.clear()
    await drain(serve("openai", handler, service))
    assert ["stream_options" in body for body in bodies] == [False]
    assert len([r for r in caplog.records if "stream_options" in r.getMessage()]) == 1

    other_handler, other_bodies = answering(*OPENROUTER)
    await drain(serve("openai", other_handler,
                      dict(OAI_CONN, service_id="s-new", base_url="http://other/v1")))
    assert other_bodies[0]["stream_options"] == {"include_usage": True}

    # The refusal is the pair's: another service at the same address is still asked with it,
    other_handler, other_bodies = answering(*OPENROUTER)
    await drain(serve("openai", other_handler, dict(service, service_id="s-twin")))
    assert other_bodies[0]["stream_options"] == {"include_usage": True}
    # and so is the same service once its address is changed.
    other_handler, other_bodies = answering(*OPENROUTER)
    await drain(serve("openai", other_handler, dict(service, base_url="http://moved/v1")))
    assert other_bodies[0]["stream_options"] == {"include_usage": True}

    openai_compat._usage_refused.clear()  # as a new start, and conftest between two tests
    bodies.clear()
    await drain(serve("openai", handler, service))
    assert ["stream_options" in body for body in bodies] == [True, False]

    openai_compat._usage_refused.clear()
    bodies.clear()
    handler, bodies = refusing_usage("This model's maximum context length is 8192 tokens.")
    with pytest.raises(ProviderError) as raised:
        await drain(serve("openai", handler, service))
    assert raised.value.status == 400
    assert len(bodies) == 1
    assert not openai_compat._usage_refused


async def test_one_model_s_refusal_of_include_usage_is_that_model_s(caplog):
    caplog.set_level(logging.INFO, logger="app.providers.openai_compat")
    # A service that passes each model's requests to its own server: one refuses the field.
    service = dict(OAI_CONN, service_id="s-router", base_url="http://router/v1")
    handler, bodies = refusing_usage()
    await drain(serve("openai", handler, dict(service, model="old-host")))
    assert ["stream_options" in body for body in bodies] == [True, False]

    other_handler, other_bodies = answering(*OPENROUTER)
    await drain(serve("openai", other_handler, dict(service, model="new-host")))
    assert other_bodies[0]["stream_options"] == {"include_usage": True}

    bodies.clear()
    await drain(serve("openai", handler, dict(service, model="old-host")))
    assert ["stream_options" in body for body in bodies] == [False]
    told = [r for r in caplog.records if "stream_options" in r.getMessage()]
    assert len(told) == 1 and "old-host" in told[0].getMessage()


async def test_a_refusal_of_include_usage_nests_with_the_reasoning_field(monkeypatch):
    service = dict(OAI_CONN, service_id="s-old", least_reasoning=True)
    bodies = []

    def handler(request):
        body = json.loads(request.content)
        bodies.append(body)
        if "stream_options" in body:
            return httpx.Response(400, json={"error": {"message": "unknown field: Include_Usage"}})
        if "reasoning" in body:
            return httpx.Response(400, json={"error": {"message": "reasoning is not supported"}})
        return httpx.Response(200, content=sse([json.dumps(c) for c in OPENROUTER] + ["[DONE]"]))

    provider = serve("openai", handler, service)

    async def least():
        return {"effort": "none"}
    monkeypatch.setattr(provider, "_reasoning_field", least)
    await drain(provider)
    assert [("stream_options" in b, "reasoning" in b) for b in bodies] == [
        (True, True), (False, True), (False, False)]
    assert provider.figures.usage == USAGE


async def test_groq_counts_under_x_groq():
    counts = {"prompt_tokens": 50, "completion_tokens": 7}
    handler, _ = answering({"id": "chatcmpl-1", "model": "llama",
                            "choices": [{"delta": {"content": "Hi."}, "finish_reason": None}]},
                           # shape unverified: Groq's final chunk, as its documentation shows it
                           {"id": "chatcmpl-1", "model": "llama",
                            "choices": [{"delta": {}, "finish_reason": "stop"}],
                            "x_groq": {"id": "req_1", "usage": counts}})
    provider = serve("openai", handler)
    await drain(provider)
    assert provider.figures.usage == counts
    assert provider.figures.usage_final


async def test_a_server_that_sends_no_usage_leaves_figures_empty():
    handler, _ = answering({"choices": [{"delta": {"content": "Hello"}, "finish_reason": None}],
                            "usage": None},
                           {"choices": [{"delta": {"content": " there."}, "finish_reason": "stop"}]})
    provider = serve("openai", handler)
    await drain(provider)
    assert provider.figures.usage == {}
    assert not provider.figures.usage_final
    assert provider.figures.chars_out == len("Hello there.")
    assert provider.figures.generation_id is None


class Held(httpx.AsyncByteStream):
    """Two pieces of a reply, then nothing more until the reader gives up."""

    async def __aiter__(self):
        yield sse([json.dumps(openrouter_chunk(content="*She ")),
                   json.dumps(openrouter_chunk(content="waits"))])
        await asyncio.Event().wait()


async def test_a_stop_keeps_the_figures_that_came():
    provider = serve("openai", lambda request: httpx.Response(200, stream=Held()))
    came = []

    async def read():
        async for event in provider.stream_chat(PAYLOAD):
            came.append(event)

    reading = asyncio.create_task(read())
    while len(came) < 2:
        await within(2, asyncio.sleep(0.01))
    reading.cancel()
    with pytest.raises(asyncio.CancelledError):
        await reading
    figures = provider.figures
    assert figures.chars_out == len("*She waits")
    assert (figures.sent, figures.opened, figures.usage_final) == (True, True, False)
    assert figures.generation_id == "gen-1"


class CutAfter(httpx.AsyncByteStream):
    """Some events, then the connection breaks."""

    def __init__(self, *events):
        self.events = events

    async def __aiter__(self):
        yield sse([json.dumps(event) for event in self.events])
        raise httpx.ReadError("The connection broke.")


async def test_a_stream_cut_after_anthropic_message_start():
    provider = serve("anthropic", lambda request: httpx.Response(200, stream=CutAfter(ANTHROPIC[0])))
    with pytest.raises(ProviderError) as raised:
        await drain(provider)
    assert raised.value.kind == CONNECTION_LOST
    figures = provider.figures
    assert not figures.usage_final
    assert figures.usage == {"input_tokens": 900, "output_tokens": 1}
    assert figures.generation_id == "msg_1"
    assert (figures.sent, figures.opened) == (True, True)


async def test_an_error_in_the_stream_keeps_the_usage_that_came():
    handler, _ = answering(openrouter_chunk(content="Hi"),
                           {"id": "gen-1", "choices": [], "usage": USAGE},
                           {"error": {"message": "The host went away."}})
    provider = serve("openai", handler)
    with pytest.raises(ProviderError) as raised:
        await drain(provider)
    assert raised.value.message == "The host went away."
    assert provider.figures.usage == USAGE
    assert provider.figures.chars_out == 2


async def test_an_unreachable_server_was_never_sent():
    def handler(request):
        raise httpx.ConnectError("nobody there", request=request)

    provider = serve("openai", handler)
    with pytest.raises(ProviderError) as raised:
        await drain(provider)
    assert raised.value.kind == UNREACHABLE
    assert (provider.figures.sent, provider.figures.opened) == (False, False)


async def test_an_error_status_was_sent_but_not_opened():
    provider = serve("openai", lambda request: httpx.Response(
        429, json={"error": {"message": "Slow down."}}))
    with pytest.raises(ProviderError) as raised:
        await drain(provider)
    assert raised.value.kind == RATE_LIMITED
    assert (provider.figures.sent, provider.figures.opened) == (True, False)


async def test_complete_answer_carries_the_figures():
    handler, _ = answering(*OPENROUTER)
    provider = serve("openai", handler)
    answer = await complete_answer(provider, PAYLOAD)
    assert answer.figures is provider.figures
    assert answer.figures.usage == USAGE
    assert answer.text == "*She smiles.*"

    assert await complete(serve("openai", handler), PAYLOAD) == "*She smiles.*"


async def test_each_request_starts_its_figures_afresh():
    handler, _ = answering(*OPENROUTER)
    provider = serve("openai", handler)
    calls = []
    provider.figures.on_id = calls.append
    await drain(provider)
    held = provider.figures
    no_usage, _ = answering({"choices": [{"delta": {"content": "Hi"}, "finish_reason": "stop"}]})
    provider._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(no_usage))
    await drain(provider)
    # The same object, so that whoever set on_id still hears of the next request.
    assert provider.figures is held and provider.figures.on_id is not None
    assert (provider.figures.usage, provider.figures.generation_id) == ({}, None)
    assert provider.figures.chars_out == 2 and not provider.figures.usage_final


async def test_a_turn_keeps_its_provider_and_what_its_server_said(client, monkeypatch):
    convo = await setup_conversation(client)
    handler, bodies = answering(*OPENROUTER)
    made = []

    def provider_for(call):
        provider = get_provider(call)
        provider._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        made.append(provider)
        return provider
    monkeypatch.setattr("app.services.chat_service.get_provider", provider_for)

    assert await send(client, convo["id"]) is None
    assert len(made) == 1 and bodies[0]["stream_options"] == {"include_usage": True}
    assert made[0].connection["service_id"]
    assert made[0].figures.usage == USAGE and made[0].figures.generation_id == "gen-1"
