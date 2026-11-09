"""What goes wrong between Evermind and a model's server is named, so that the
interface can say it in the person's language.

Each failure has a ``kind``, and its ``message`` is what the model's server said,
untouched, or the address it could not be reached at: Evermind cannot translate
what another program wrote, only frame it."""

import json

import httpx
import pytest

from app.errors import NO_CONNECTION
from app.providers import get_provider
from app.providers.base import ProviderError

from .conftest import PAYLOAD, anth_provider, collect, oai_provider, send, setup_conversation, sse

PROVIDERS = [("openai-compatible", oai_provider), ("anthropic", anth_provider)]


def answering(status: int, body):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body) if body is not None else httpx.Response(status)

    return handler


def raising(error_type, *args):
    def handler(request: httpx.Request) -> httpx.Response:
        raise error_type(*args, request=request)

    return handler


async def reply(provider):
    return await collect(provider)


async def models(provider):
    return await provider.list_models()


ASKING = [pytest.param(reply, id="reply"), pytest.param(models, id="models")]


async def failure_of(ask, provider) -> ProviderError:
    with pytest.raises(ProviderError) as raised:
        await ask(provider)
    return raised.value


@pytest.mark.parametrize("ask", ASKING)
@pytest.mark.parametrize(("name", "make"), PROVIDERS)
@pytest.mark.parametrize(
    ("status", "kind"),
    [
        (401, "model_auth_refused"),
        (404, "model_not_found"),
        (429, "model_rate_limited"),
        (500, "model_error"),
        (529, "model_error"),
        (400, "model_error"),
    ],
)
async def test_an_error_status_is_named_and_keeps_the_servers_words(ask, name, make, status, kind):
    handler = answering(status, {"error": {"message": "The server's own words."}})
    error = await failure_of(ask, make(handler))
    assert (error.kind, error.message, error.status) == (kind, "The server's own words.", status)
    assert error.status_code == 502


@pytest.mark.parametrize("body", [
    {"error": {"message": "Model not loaded."}},
    {"error": "Model not loaded."},
    {"object": "error", "message": "Model not loaded."},
], ids=["openai", "ollama", "vllm"])
async def test_the_servers_words_are_found_where_it_puts_them(body):
    assert (await failure_of(reply, oai_provider(answering(500, body)))).message == "Model not loaded."


@pytest.mark.parametrize("content", [b"", b"<html><body><h1>502 Bad Gateway</h1></body></html>"])
async def test_an_error_status_without_words_says_its_status(content):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(502, content=content)

    for ask in (reply, models):
        assert (await failure_of(ask, oai_provider(handler))).message == "HTTP 502"


@pytest.mark.parametrize("ask", ASKING)
@pytest.mark.parametrize(("name", "make"), PROVIDERS)
@pytest.mark.parametrize("error_type", [httpx.ConnectError, httpx.ConnectTimeout])
async def test_a_server_that_cannot_be_reached_is_unreachable_at_its_address(
        ask, name, make, error_type):
    provider = make(raising(error_type, "refused"))
    error = await failure_of(ask, provider)
    assert (error.kind, error.message) == ("unreachable", provider.base_url)


@pytest.mark.parametrize("ask", ASKING)
@pytest.mark.parametrize("name", [name for name, _ in PROVIDERS])
@pytest.mark.parametrize("address", ["127.0.0.1:1/v1", "http://127.0.0.1:x/v1"])
async def test_an_address_that_is_not_one_is_unreachable_at_that_address(ask, name, address):
    error = await failure_of(ask, get_provider({"provider": name, "base_url": address}))
    assert (error.kind, error.message) == ("unreachable", address)


@pytest.mark.parametrize("ask", ASKING)
@pytest.mark.parametrize(("name", "make"), PROVIDERS)
@pytest.mark.parametrize("error_type", [httpx.ReadTimeout, httpx.ReadError, httpx.RemoteProtocolError])
async def test_a_connection_that_breaks_or_goes_quiet_is_lost(ask, name, make, error_type):
    error = await failure_of(ask, make(raising(error_type, "connection reset")))
    assert (error.kind, error.message) == ("model_connection_lost", "connection reset")


async def test_a_connection_lost_without_words_still_says_so():
    error = await failure_of(reply, oai_provider(raising(httpx.ReadTimeout, "")))
    assert (error.kind, error.message) == (
        "model_connection_lost",
        "The model took too long to answer, or the connection to its server broke.")


class BreaksAfterAWord(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield sse([json.dumps({"choices": [{"delta": {"content": "Hel"}}]})])
        raise httpx.ReadError("connection reset")


async def test_a_reply_cut_off_midway_gives_what_arrived_then_the_failure():
    provider = oai_provider(lambda _: httpx.Response(200, stream=BreaksAfterAWord()))
    arrived = []
    with pytest.raises(ProviderError) as raised:
        async for event in provider.stream_chat(PAYLOAD):
            arrived.append(event.text)
    assert arrived == ["Hel"]
    assert raised.value.kind == "model_connection_lost"


async def test_the_anthropic_stream_error_is_the_servers_own_words():
    body = b'data: {"type":"error","error":{"message":"Overloaded right now"}}\n\n'
    error = await failure_of(reply, anth_provider(lambda _: httpx.Response(200, content=body)))
    assert (error.kind, error.message, error.status) == ("model_error", "Overloaded right now", None)


@pytest.mark.parametrize("error", [{"code": 429, "message": "Rate limited"}, "Rate limited"])
@pytest.mark.parametrize("before", [[], ['{"choices":[{"delta":{"content":"Hel"}}]}']])
async def test_an_error_in_an_openai_compatible_stream_ends_the_reply(error, before):
    body = sse([*before, json.dumps({"error": error}), "[DONE]"])
    provider = oai_provider(lambda _: httpx.Response(200, content=body))
    arrived = []
    with pytest.raises(ProviderError) as raised:
        async for event in provider.stream_chat(PAYLOAD):
            arrived.append(event.type)
    assert arrived == ["delta"] * len(before)
    assert (raised.value.kind, raised.value.message, raised.value.status) == (
        "model_error", "Rate limited", None)


@pytest.mark.parametrize(("name", "make"), PROVIDERS)
@pytest.mark.parametrize("content", [b"<html>not json</html>", b'["a", "b"]', b'{"data": 5}'])
async def test_a_list_of_models_that_cannot_be_read_is_unreadable(name, make, content):
    error = await failure_of(models, make(lambda _: httpx.Response(200, content=content)))
    assert error.kind == "model_unreadable"


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
    resp = await client.post("/api/connections/test", json=connection)
    assert resp.status_code == 502
    assert resp.json() == {"error": "bad key", "kind": "model_auth_refused"}


async def test_a_connection_test_before_saving_names_the_address_it_could_not_reach(
        client, monkeypatch):
    patch_providers(monkeypatch, lambda: oai_provider(raising(httpx.ConnectError, "refused")))
    resp = await client.post("/api/connections/test", json={
        "name": "Mock", "provider": "openai-compatible",
        "base_url": "http://mock/v1", "model": "test-model",
    })
    assert resp.status_code == 502
    assert resp.json() == {"error": "http://mock/v1", "kind": "unreachable"}


async def test_a_connection_test_that_works_says_how_many_models(client, monkeypatch):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"id": "a"}, {"id": "b"}, {"id": "c"}]})

    patch_providers(monkeypatch, lambda: oai_provider(handler))
    connection = await saved_connection(client)
    body = (await client.post("/api/connections/test", json=connection)).json()
    assert body == {
        "ok": True, "detail": "3 models available", "model_count": 3,
        "models_sample": ["a", "b", "c"],
    }


@pytest.mark.parametrize("action", ["test", "benchmark"])
async def test_trying_a_saved_connection_as_edited_lends_it_its_key_and_saves_nothing(
        client, monkeypatch, action):
    tried = {}

    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": []})
        return httpx.Response(200, content=sse([
            json.dumps({"choices": [{"delta": {"content": "Rain."}}]}), "[DONE]"]))

    def provider(connection):
        tried.update(connection)
        return oai_provider(answer)

    monkeypatch.setattr("app.routers.connections.get_provider", provider)
    saved = (await client.post("/api/connections", json={
        "name": "Mock", "base_url": "http://mock/v1", "api_key": "sk-kept", "model": "kept",
    })).json()

    body = (await client.post(f"/api/connections/{action}", json={**saved, "model": "oops"})).json()

    assert body["ok"] is True
    assert (tried["api_key"], tried["model"]) == ("sk-kept", "oops")
    assert (await client.get("/api/connections")).json()[0]["model"] == "kept"


async def test_a_benchmark_names_what_failed(client, monkeypatch):
    patch_providers(monkeypatch, lambda: oai_provider(answering(429, {"error": "slow down"})))
    connection = await saved_connection(client)
    resp = await client.post("/api/connections/benchmark", json=connection)
    assert resp.status_code == 502
    assert resp.json() == {"error": "slow down", "kind": "model_rate_limited"}


async def test_a_benchmark_that_produced_nothing_says_so(client, monkeypatch):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"data: [DONE]\n\n")

    patch_providers(monkeypatch, lambda: oai_provider(handler))
    connection = await saved_connection(client)
    resp = await client.post("/api/connections/benchmark", json=connection)
    assert resp.status_code == 502
    assert resp.json() == {"error": "No text generated.", "kind": "model_no_text"}


async def test_a_model_error_in_a_reply_keeps_what_the_server_said(client, monkeypatch):
    convo = await setup_conversation(client)
    patch_providers(monkeypatch, lambda: oai_provider(answering(401, {"error": "bad key"})))
    assert await send(client, convo["id"], content="Hi") == {
        "message": "bad key", "kind": "model_auth_refused", "mode": "send",
    }


async def test_a_failed_story_tool_keeps_what_the_server_said(client, monkeypatch):
    convo = await setup_conversation(client)
    patch_providers(monkeypatch, lambda: oai_provider(answering(500, {"error": "boom"})))
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert resp.status_code == 502
    assert resp.json() == {"error": "boom", "kind": "model_error"}


async def test_a_failed_card_assistant_keeps_what_the_server_said(client, monkeypatch):
    await saved_connection(client)
    patch_providers(monkeypatch, lambda: oai_provider(answering(500, {"error": "boom"})))
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 502
    assert resp.json() == {"error": "boom", "kind": "model_error"}


async def test_a_failed_memory_pass_keeps_what_the_server_said(client, monkeypatch):
    def replying(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=sse([
            '{"choices":[{"delta":{"content":"Hello."}}]}', "[DONE]",
        ]))

    convo = await setup_conversation(client)
    patch_providers(monkeypatch, lambda: oai_provider(replying))
    await send(client, convo["id"], content="Hi")

    patch_providers(monkeypatch, lambda: oai_provider(answering(500, {"error": "boom"})))
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.status_code == 502
    assert resp.json() == {"error": "boom", "kind": "model_error"}


async def test_no_connection_is_not_a_provider_failure(client):
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert (resp.status_code, resp.json()["kind"]) == (400, NO_CONNECTION)


async def test_a_connection_test_of_a_server_that_is_not_there_names_the_address(client):
    resp = await client.post("/api/connections/test", json={
        "name": "Mock", "provider": "openai-compatible",
        "base_url": "http://127.0.0.1:1/v1", "model": "x",
    })
    assert resp.status_code == 502
    assert resp.json() == {"error": "http://127.0.0.1:1/v1", "kind": "unreachable"}
