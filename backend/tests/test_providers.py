"""Provider tests over httpx.MockTransport — no network."""

import json

import httpx
import pytest

from app.prompting.engine import PromptPayload
from app.providers import get_provider
from app.providers.anthropic import AnthropicProvider
from app.providers.base import ProviderError
from app.providers.openai_compat import OpenAICompatProvider

PAYLOAD = PromptPayload(
    system="You are Serana.",
    messages=[
        {"role": "assistant", "content": "*She stirs.*"},
        {"role": "user", "content": "Hello"},
    ],
    stop=["\nAlex:"],
    post_history="Stay tense.",
)

OAI_CONN = {
    "provider": "openai-compatible",
    "base_url": "http://mock/v1",
    "api_key": "sk-test",
    "model": "test-model",
    "context_size": 8192,
    "max_tokens": 256,
    "temperature": 0.9,
    "top_p": 0.95,
    "frequency_penalty": 0.1,
    "presence_penalty": 0.1,
    "extra_params": {},
}

ANTH_CONN = dict(OAI_CONN, provider="anthropic", base_url="https://mock.anthropic.com", api_key="sk-ant")


def sse(lines: list[str]) -> bytes:
    return "".join(f"data: {line}\n\n" for line in lines).encode()


async def collect(provider, payload=PAYLOAD):
    return [e async for e in provider.stream_chat(payload)]


# ---------- openai-compatible ----------

def oai_provider(handler) -> OpenAICompatProvider:
    p = OpenAICompatProvider(OAI_CONN)
    p._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return p


async def test_openai_stream_deltas_and_done():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        captured["auth"] = request.headers.get("authorization")
        body = sse([
            json.dumps({"choices": [{"delta": {"role": "assistant"}}]}),
            json.dumps({"choices": [{"delta": {"content": "Hel"}}]}),
            json.dumps({"choices": [{"delta": {"content": "lo"}}], "usage": {"total_tokens": 42}}),
            "[DONE]",
        ])
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    events = await collect(oai_provider(handler))
    texts = [e.text for e in events if e.type == "delta"]
    assert texts == ["Hel", "lo"]
    assert events[-1].type == "done"
    assert events[-1].usage == {"total_tokens": 42}

    body = captured["body"]
    assert captured["auth"] == "Bearer sk-test"
    assert body["model"] == "test-model"
    assert body["stream"] is True
    assert body["messages"][0] == {"role": "system", "content": "You are Serana."}
    # post_history rides on the last user turn — a trailing system message is
    # dropped by many local chat templates (Mistral & co)
    last = body["messages"][-1]
    assert last["role"] == "user"
    assert last["content"] == "Hello\n\nStay tense."
    assert body["stop"] == ["\nAlex:"]


async def test_openai_401_yields_readable_error():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "bad key"}})

    events = await collect(oai_provider(handler))
    assert events[-1].type == "error"
    assert "401" in events[-1].message or "cl" in events[-1].message.lower()


async def test_openai_connect_error_readable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    events = await collect(oai_provider(handler))
    assert events[-1].type == "error"
    assert "http://mock/v1" in events[-1].message


async def test_openai_list_models():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/models")
        return httpx.Response(200, json={"data": [{"id": "m1"}, {"id": "m2"}]})

    models = await oai_provider(handler).list_models()
    assert models == ["m1", "m2"]


async def test_openai_no_post_history_no_trailing_system():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=sse(["[DONE]"]))

    payload = PromptPayload(system="S", messages=[{"role": "user", "content": "hi"}], stop=[])
    await collect(oai_provider(handler), payload)
    assert captured["body"]["messages"][-1] == {"role": "user", "content": "hi"}


async def test_openai_post_history_without_user_turn_falls_back_to_system():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=sse(["[DONE]"]))

    payload = PromptPayload(system="S", messages=[{"role": "assistant", "content": "greeting"}],
                            stop=[], post_history="Note.")
    await collect(oai_provider(handler), payload)
    assert captured["body"]["messages"][-1] == {"role": "system", "content": "Note."}


async def test_openai_post_history_does_not_mutate_payload():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=sse(["[DONE]"]))

    await collect(oai_provider(handler))
    # PAYLOAD is module-level and reused across tests: the suffix must land on
    # a copy, never on the shared dict.
    assert PAYLOAD.messages[-1]["content"] == "Hello"


# ---------- anthropic ----------

def anth_provider(handler) -> AnthropicProvider:
    p = AnthropicProvider(ANTH_CONN)
    p._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return p


async def test_anthropic_stream_and_message_shaping():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        captured["key"] = request.headers.get("x-api-key")
        body = (
            'event: message_start\ndata: {"type":"message_start"}\n\n'
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi "}}\n\n'
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"you"}}\n\n'
            'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n'
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        ).encode()
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    events = await collect(anth_provider(handler))
    assert [e.text for e in events if e.type == "delta"] == ["Hi ", "you"]
    assert events[-1].type == "done"

    body = captured["body"]
    assert captured["key"] == "sk-ant"
    assert body["system"] == "You are Serana."
    # first message must be user: synthetic opener inserted before assistant greeting
    assert body["messages"][0]["role"] == "user"
    # post_history suffixed onto the last user message
    assert body["messages"][-1]["role"] == "user"
    assert "Stay tense." in body["messages"][-1]["content"]
    assert "frequency_penalty" not in body
    assert body["stop_sequences"] == ["\nAlex:"]


async def test_anthropic_merges_consecutive_same_role():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=b'event: message_stop\ndata: {"type":"message_stop"}\n\n')

    payload = PromptPayload(
        system="S",
        messages=[
            {"role": "user", "content": "a"},
            {"role": "user", "content": "b"},
            {"role": "assistant", "content": "c"},
        ],
        stop=[],
    )
    await collect(anth_provider(handler), payload)
    roles = [m["role"] for m in captured["body"]["messages"]]
    assert roles == ["user", "assistant"]
    assert captured["body"]["messages"][0]["content"] == "a\n\nb"


async def test_anthropic_http_error_readable():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(529, json={"error": {"type": "overloaded_error", "message": "Overloaded"}})

    events = await collect(anth_provider(handler))
    assert events[-1].type == "error"
    assert "Overloaded" in events[-1].message or "529" in events[-1].message


# ---------- factory ----------

def test_get_provider_dispatch():
    assert isinstance(get_provider(OAI_CONN), OpenAICompatProvider)
    assert isinstance(get_provider(ANTH_CONN), AnthropicProvider)
    with pytest.raises(ProviderError):
        get_provider({"provider": "nope"})
