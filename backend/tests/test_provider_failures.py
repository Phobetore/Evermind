"""What goes wrong between Evermind and a model's server is named, so that the
interface can say it in the person's language.

Each failure has a ``kind`` and, where the model's server said something of its
own, that text as ``upstream`` (and its status as ``upstream_status``), untouched:
Evermind cannot translate what another program wrote, only frame it. The English
sentence stays for whoever reads the API."""

import httpx
import pytest

from app.errors import NO_CONNECTION
from app.providers import get_provider
from app.providers.base import ProviderError

from .test_chat import parse_sse, setup_conversation
from .test_providers import anth_provider, collect, oai_provider, sse

PROVIDERS = [("openai-compatible", oai_provider), ("anthropic", anth_provider)]


def answering(status: int, body):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body) if body is not None else httpx.Response(status)

    return handler


def raising(error_type, *args):
    def handler(request: httpx.Request) -> httpx.Response:
        raise error_type(*args, request=request)

    return handler


@pytest.mark.parametrize(("name", "make"), PROVIDERS)
@pytest.mark.parametrize(
    ("status", "kind"),
    [
        (401, "model_auth_refused"),
        (404, "model_not_found"),
        (429, "model_rate_limited"),
        (500, "model_http_error"),
        (529, "model_http_error"),
        (400, "model_http_error"),
    ],
)
async def test_an_error_status_is_named(name, make, status, kind):
    handler = answering(status, {"error": {"message": "The server's own words."}})
    event = (await collect(make(handler)))[-1]
    assert event.type == "error"
    assert event.meta["kind"] == kind
    assert event.meta["upstream_status"] == status
    assert event.meta["upstream"] == "The server's own words."


@pytest.mark.parametrize(("name", "make"), PROVIDERS)
async def test_an_error_status_without_words_has_no_upstream(name, make):
    event = (await collect(make(answering(500, None))))[-1]
    assert event.meta["kind"] == "model_http_error"
    assert "upstream" not in event.meta


@pytest.mark.parametrize(("name", "make"), PROVIDERS)
async def test_a_server_that_takes_too_long_is_named(name, make):
    event = (await collect(make(raising(httpx.ReadTimeout, "slow"))))[-1]
    assert event.meta == {"kind": "model_timeout"}
    assert "timeout" in event.message


@pytest.mark.parametrize(("name", "make"), PROVIDERS)
async def test_any_other_network_failure_is_named_and_keeps_its_words(name, make):
    event = (await collect(make(raising(httpx.ReadError, "connection reset"))))[-1]
    assert event.meta == {"kind": "model_network_error", "upstream": "connection reset"}
    assert event.message == "Network error: connection reset"


@pytest.mark.parametrize(("name", "make"), PROVIDERS)
async def test_a_server_that_cannot_be_reached_is_still_unreachable(name, make):
    event = (await collect(make(raising(httpx.ConnectError, "refused"))))[-1]
    assert event.meta == {"kind": "unreachable"}


async def test_the_english_sentences_are_as_they_were():
    event = (await collect(oai_provider(answering(401, {"error": {"message": "bad key"}}))))[-1]
    assert event.message == "Authentication refused (401): invalid or missing API key. bad key"
    event = (await collect(oai_provider(answering(404, {"error": "nope"}))))[-1]
    assert event.message == (
        'Endpoint or model not found (404). Check the URL and the model "test-model". nope'
    )
    event = (await collect(oai_provider(answering(503, {"error": "down"}))))[-1]
    assert event.message == "LLM server error (503). down"
    event = (await collect(anth_provider(answering(529, {"error": {"message": "Overloaded"}}))))[-1]
    assert event.message == "Anthropic error (529). Overloaded"


async def test_the_anthropic_stream_error_is_the_servers_own_words():
    body = b'data: {"type":"error","error":{"message":"Overloaded right now"}}\n\n'

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    event = (await collect(anth_provider(handler)))[-1]
    assert event.message == "Overloaded right now"
    assert event.meta == {"kind": "model_error"}


@pytest.mark.parametrize(("name", "make"), PROVIDERS)
async def test_listing_models_names_an_error_status(name, make):
    with pytest.raises(ProviderError) as raised:
        await make(answering(401, {"error": {"message": "bad key"}})).list_models()
    assert raised.value.kind == "model_auth_refused"
    assert raised.value.details == {"upstream_status": 401, "upstream": "bad key"}


@pytest.mark.parametrize(("name", "make"), PROVIDERS)
async def test_listing_models_names_an_answer_it_cannot_read(name, make):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html>not json</html>")

    with pytest.raises(ProviderError) as raised:
        await make(handler).list_models()
    assert raised.value.kind == "model_unexpected_response"


@pytest.mark.parametrize(("name", "make"), PROVIDERS)
async def test_listing_models_names_a_network_failure(name, make):
    with pytest.raises(ProviderError) as raised:
        await make(raising(httpx.ReadError, "connection reset")).list_models()
    assert raised.value.kind == "model_network_error"
    assert raised.value.details == {"upstream": "connection reset"}


def test_an_unknown_connection_type_is_named():
    with pytest.raises(ProviderError) as raised:
        get_provider({"provider": "nope"})
    assert raised.value.kind == "model_unknown_type"


# --- as the API reports them ---------------------------------------------------


def patch_providers(monkeypatch, make):
    """Every service that talks to a model talks to one built by ``make``."""
    for module in ("chat_service", "card_assistant", "memory_service"):
        monkeypatch.setattr(f"app.services.{module}.get_provider", lambda connection: make())
    monkeypatch.setattr("app.routers.connections.get_provider", lambda connection: make())


async def saved_connection(client):
    return (await client.post("/api/connections", json={
        "name": "Mock", "provider": "openai-compatible",
        "base_url": "http://mock/v1", "model": "test-model",
    })).json()


async def test_a_connection_test_names_what_failed(client, monkeypatch):
    patch_providers(monkeypatch, lambda: oai_provider(answering(401, {"error": "bad key"})))
    connection = await saved_connection(client)
    resp = await client.post(f"/api/connections/{connection['id']}/test")
    assert resp.status_code == 200
    assert resp.json() == {
        "ok": False,
        "detail": "Authentication refused (401): invalid or missing API key. bad key",
        "kind": "model_auth_refused",
        "upstream_status": 401,
        "upstream": "bad key",
    }


async def test_a_connection_test_before_saving_names_what_failed(client, monkeypatch):
    patch_providers(monkeypatch, lambda: oai_provider(raising(httpx.ConnectError, "refused")))
    resp = await client.post("/api/connections/test", json={
        "name": "Mock", "provider": "openai-compatible",
        "base_url": "http://mock/v1", "model": "test-model",
    })
    body = resp.json()
    assert body["ok"] is False
    assert body["kind"] == "unreachable"
    assert "http://mock/v1" in body["detail"]


async def test_a_connection_test_that_works_says_how_many_models(client, monkeypatch):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"id": "a"}, {"id": "b"}, {"id": "c"}]})

    patch_providers(monkeypatch, lambda: oai_provider(handler))
    connection = await saved_connection(client)
    body = (await client.post(f"/api/connections/{connection['id']}/test")).json()
    assert body == {
        "ok": True, "detail": "3 models available", "model_count": 3,
        "models_sample": ["a", "b", "c"],
    }


async def test_a_benchmark_names_what_failed(client, monkeypatch):
    patch_providers(monkeypatch, lambda: oai_provider(answering(429, {"error": "slow down"})))
    connection = await saved_connection(client)
    body = (await client.post(f"/api/connections/{connection['id']}/benchmark")).json()
    assert body["ok"] is False
    assert body["kind"] == "model_rate_limited"
    assert body["upstream"] == "slow down"
    assert body["detail"].startswith("Rate limit reached (429)")


async def test_a_benchmark_that_produced_nothing_says_so(client, monkeypatch):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"data: [DONE]\n\n")

    patch_providers(monkeypatch, lambda: oai_provider(handler))
    connection = await saved_connection(client)
    body = (await client.post(f"/api/connections/{connection['id']}/benchmark")).json()
    assert body == {"ok": False, "detail": "No text generated.", "kind": "model_no_text"}


async def test_listing_models_names_what_failed(client, monkeypatch):
    patch_providers(monkeypatch, lambda: oai_provider(answering(500, None)))
    connection = await saved_connection(client)
    body = (await client.get(f"/api/connections/{connection['id']}/models")).json()
    assert body["models"] == []
    assert body["kind"] == "model_http_error"
    assert body["upstream_status"] == 500


async def test_a_model_error_in_a_reply_keeps_what_the_server_said(client, monkeypatch):
    convo = await setup_conversation(client)
    patch_providers(monkeypatch, lambda: oai_provider(answering(401, {"error": "bad key"})))
    resp = await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "send", "content": "Hi",
    })
    event = parse_sse(resp.text)[-1]
    assert event == {
        "type": "error",
        "message": "Authentication refused (401): invalid or missing API key. bad key",
        "kind": "model_auth_refused",
        "upstream_status": 401,
        "upstream": "bad key",
    }


@pytest.mark.parametrize("route", ["impersonate", "summarize"])
async def test_a_failed_story_tool_keeps_what_the_server_said(client, monkeypatch, route):
    convo = await setup_conversation(client)
    patch_providers(monkeypatch, lambda: oai_provider(answering(500, {"error": "boom"})))
    resp = await client.post(f"/api/conversations/{convo['id']}/{route}")
    assert resp.status_code == 502
    body = resp.json()
    assert body["kind"] == "model_http_error"
    assert body["upstream_status"] == 500
    assert body["upstream"] == "boom"
    assert body["error"].startswith("LLM server error (500)")


async def test_a_failed_card_assistant_keeps_what_the_server_said(client, monkeypatch):
    await saved_connection(client)
    patch_providers(monkeypatch, lambda: oai_provider(answering(500, {"error": "boom"})))
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 502
    assert resp.json()["kind"] == "model_http_error"
    assert resp.json()["upstream"] == "boom"


async def test_a_failed_memory_pass_keeps_what_the_server_said(client, monkeypatch):
    def replying(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=sse([
            '{"choices":[{"delta":{"content":"Hello."}}]}', "[DONE]",
        ]))

    convo = await setup_conversation(client)
    patch_providers(monkeypatch, lambda: oai_provider(replying))
    await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "send", "content": "Hi",
    })

    patch_providers(monkeypatch, lambda: oai_provider(answering(500, {"error": "boom"})))
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.status_code == 502
    assert resp.json()["kind"] == "model_http_error"
    assert resp.json()["upstream"] == "boom"


async def test_no_connection_is_not_a_provider_failure(client):
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.json()["kind"] == NO_CONNECTION
    assert "upstream" not in resp.json()
