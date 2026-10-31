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
async def test_a_server_that_cannot_be_reached_is_still_unreachable_and_says_where(name, make):
    provider = make(raising(httpx.ConnectError, "refused"))
    event = (await collect(provider))[-1]
    assert event.meta == {"kind": "unreachable", "upstream_url": provider.base_url}
    assert provider.base_url in event.message


@pytest.mark.parametrize(("name", "make"), PROVIDERS)
async def test_listing_models_of_a_server_that_cannot_be_reached_says_where(name, make):
    provider = make(raising(httpx.ConnectError, "refused"))
    with pytest.raises(ProviderError) as raised:
        await provider.list_models()
    assert raised.value.kind == "unreachable"
    assert raised.value.details == {"upstream_url": provider.base_url}


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


@pytest.mark.parametrize(("name", "make"), PROVIDERS)
async def test_listing_models_keeps_an_excerpt_of_an_answer_that_is_not_json(name, make):
    """A proxy in front of the model's server answers with a page of its own,
    and its words are the only clue to what stands in the way."""
    page = b"<html>\n  <body>\n    <h1>502   Bad gateway</h1>\n  </body>\n</html>"

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(502, content=page)

    with pytest.raises(ProviderError) as raised:
        await make(handler).list_models()
    assert raised.value.kind == "model_http_error"
    # The words of the page, not its markup.
    assert raised.value.details == {"upstream_status": 502, "upstream": "502 Bad gateway"}
    assert "Bad gateway" in raised.value.message


@pytest.mark.parametrize(
    ("page", "words"),
    [
        (b"<h1>502 Bad Gateway</h1><hr><center>nginx/1.25</center>", "502 Bad Gateway nginx/1.25"),
        (b"<html><head><title>Oops</title><style>h1 { color: red }</style></head>"
         b"<body><script>track('x')</script><h1>Server is down</h1></body></html>",
         "Oops Server is down"),
        (b"<!-- generated --><p>Error &amp; retry &lt;soon&gt;, it&#39;s &quot;busy&quot;</p>",
         "Error & retry <soon>, it's \"busy\""),
        # Text that is not markup is left as it is, a comparison included.
        (b"Upstream is down: queue length < limit, and > 5 retries",
         "Upstream is down: queue length < limit, and > 5 retries"),
    ],
)
async def test_the_excerpt_of_a_page_is_its_words(page, words):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(502, content=page)

    with pytest.raises(ProviderError) as raised:
        await oai_provider(handler).list_models()
    assert raised.value.details["upstream"] == words


@pytest.mark.parametrize(("name", "make"), PROVIDERS)
async def test_the_excerpt_of_a_long_answer_is_short(name, make):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(502, content=b"word " * 500)

    with pytest.raises(ProviderError) as raised:
        await make(handler).list_models()
    assert 0 < len(raised.value.details["upstream"]) <= 300


async def test_a_stream_answered_with_a_page_has_no_words_to_show():
    """Only the model list quotes a page: a reply's error stays as short as it was."""
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(502, content=b"<html>Bad gateway</html>")

    event = (await collect(oai_provider(handler)))[-1]
    assert event.meta == {"kind": "model_http_error", "upstream_status": 502}
    assert event.message == "LLM server error (502)."


# --- a connection of a type nobody knows -------------------------------------------


async def test_an_unknown_connection_type_fails_like_any_model_that_fails():
    provider = get_provider({"provider": "nope"})
    events = await collect(provider)
    assert [event.type for event in events] == ["error"]
    assert events[0].meta == {"kind": "model_unknown_type"}
    assert events[0].message == 'Unknown connection type: "nope"'
    with pytest.raises(ProviderError) as raised:
        await provider.list_models()
    assert raised.value.kind == "model_unknown_type"
    assert (await provider.test()) == {
        "ok": False, "detail": 'Unknown connection type: "nope"', "kind": "model_unknown_type",
    }


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


# --- a connection row that has been corrupted -----------------------------------------


async def corrupt_connection(client) -> dict:
    """Every saved connection (there is one if the test has none yet) given a
    type that nobody knows, as a hand-edited database or a downgrade leaves it:
    neither the API nor the table's CHECK would have let it in."""
    from app.db import _connect

    if not (await client.get("/api/connections")).json():
        await saved_connection(client)
    db = await _connect()
    try:
        await db.execute("PRAGMA ignore_check_constraints = ON")
        await db.execute("UPDATE connections SET provider = 'nope'")
        await db.commit()
    finally:
        await db.close()
    return (await client.get("/api/connections")).json()[0]


async def test_a_reply_on_a_corrupted_connection_says_so(client):
    convo = await setup_conversation(client)
    await corrupt_connection(client)
    resp = await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "send", "content": "Hi",
    })
    assert resp.status_code == 200
    event = parse_sse(resp.text)[-1]
    assert event["type"] == "error"
    assert event["kind"] == "model_unknown_type"


@pytest.mark.parametrize("route", ["impersonate", "summarize"])
async def test_a_story_tool_on_a_corrupted_connection_says_so(client, route):
    convo = await setup_conversation(client)
    await corrupt_connection(client)
    resp = await client.post(f"/api/conversations/{convo['id']}/{route}")
    assert resp.status_code == 502
    assert resp.json()["kind"] == "model_unknown_type"


async def test_the_test_of_a_corrupted_connection_says_so(client):
    connection = await corrupt_connection(client)
    body = (await client.post(f"/api/connections/{connection['id']}/test")).json()
    assert body["ok"] is False
    assert body["kind"] == "model_unknown_type"


async def test_a_connection_test_of_a_server_that_is_not_there_names_the_address(client):
    resp = await client.post("/api/connections/test", json={
        "name": "Mock", "provider": "openai-compatible",
        "base_url": "http://127.0.0.1:1/v1", "model": "x",
    })
    body = resp.json()
    assert body["kind"] == "unreachable"
    assert body["upstream_url"] == "http://127.0.0.1:1/v1"


# --- a secret in the address ---------------------------------------------------------


def test_userinfo_is_taken_out_of_an_address():
    from app.providers.base import without_userinfo

    assert without_userinfo("http://user:secret@host:8080/v1") == "http://host:8080/v1"
    assert without_userinfo("https://user@host/v1") == "https://host/v1"
    assert without_userinfo("http://a@b:c@host/v1") == "http://host/v1"
    assert without_userinfo("http://user:secret@[::1]:1234/v1") == "http://[::1]:1234/v1"
    # Nothing to take out.
    for url in ("http://host:8080/v1", "http://[::1]:1234/v1", "localhost:1234", "",
                "http://host/v1?contact=me@example.org", "http://host/v1#a@b"):
        assert without_userinfo(url) == url


@pytest.mark.parametrize("make", [oai_provider, anth_provider])
async def test_a_password_in_the_address_does_not_leave_with_the_error(make):
    provider = make(raising(httpx.ConnectError, "refused"))
    provider.base_url = "http://user:secret@mock.example:1234/v1"
    event = (await collect(provider))[-1]
    assert "secret" not in repr(event) and "user:" not in repr(event)
    assert event.meta["upstream_url"] == "http://mock.example:1234/v1"
    assert "http://mock.example:1234/v1" in event.message

    with pytest.raises(ProviderError) as raised:
        await provider.list_models()
    assert "secret" not in raised.value.message
    assert raised.value.details == {"upstream_url": "http://mock.example:1234/v1"}


async def test_the_connection_test_does_not_give_the_password_back(client):
    resp = await client.post("/api/connections/test", json={
        "name": "Mock", "provider": "openai-compatible",
        "base_url": "http://user:secret@127.0.0.1:1/v1", "model": "x",
    })
    assert resp.json()["upstream_url"] == "http://127.0.0.1:1/v1"
    assert "secret" not in resp.text


# --- the excerpt of what a server answered -------------------------------------------


def test_the_excerpt_drops_an_xml_prolog():
    from app.providers.base import excerpt

    page = '<?xml version="1.0" encoding="UTF-8"?><Error><Message>Access denied</Message></Error>'
    assert excerpt(page) == "Access denied"


def test_the_excerpt_looks_at_the_start_of_a_large_answer_only():
    """The work is bounded by what is looked at, not by what was sent: the
    request runs on the event loop that live replies are streamed on."""
    from app.providers.base import excerpt

    assert len(excerpt("x" * 100_000, limit=1_000_000)) == 4_000
    # Words after the part that is looked at are not found, which is the price.
    assert "needle" not in excerpt("<p>" + "word " * 2_000 + "needle", limit=1_000_000)
    # Markup that never closes is cheap to give up on.
    assert excerpt("words " + "<script>" * 400) == "words"


@pytest.mark.parametrize("name", ["style", "script", "STYLE", "Script"])
@pytest.mark.parametrize("content", ["a { color: red } ", "var x = 1; "])
def test_the_excerpt_drops_a_block_that_the_part_looked_at_ends_inside(name, content):
    """A page that is cut off inside its style or its script has no words in what
    is left of it, only code, which is not what the person needs to read. It is
    what a long inline style at the top of an error page leaves in the part looked
    at."""
    from app.providers.base import excerpt

    page = f"<title>Bad gateway</title><{name} type=\"x\">" + content * 1_000
    assert excerpt(page) == "Bad gateway"
    # The same when the block does close, but only after the part that is looked at.
    assert excerpt(page + f"</{name}><p>after</p>") == "Bad gateway"


def test_the_excerpt_keeps_the_words_around_a_style_and_a_script_that_close():
    from app.providers.base import excerpt

    page = "Down <style>p { color: red }</style> for <script>track()</script> now"
    assert excerpt(page) == "Down for now"


async def test_the_anthropic_model_list_message_quotes_the_words_of_a_page():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(502, content=b"<html>\n<body><h1>502   Bad gateway</h1></body>\n</html>")

    with pytest.raises(ProviderError) as raised:
        await anth_provider(handler).list_models()
    assert raised.value.message == "Anthropic error (502): 502 Bad gateway"


async def test_the_anthropic_model_list_message_is_as_it_was_for_a_json_error():
    with pytest.raises(ProviderError) as raised:
        await anth_provider(answering(401, {"error": {"message": "bad key"}})).list_models()
    assert raised.value.message == 'Anthropic error (401): {"error":{"message":"bad key"}}'
