"""Every error the API raises names itself with a ``kind``, so that the interface
can say it in the person's own language. The English ``error`` sentence stays
for clients that read it."""

import ast
from pathlib import Path

import pytest

import app as app_package
from app.providers.base import ProviderError, ProviderEvent

from .conftest import FakeProvider, send, setup_conversation


@pytest.fixture()
def provider(monkeypatch):
    """The one scripted model every service that calls a model talks to."""
    FakeProvider.script = [ProviderEvent(type="delta", text="Hello."), ProviderEvent(type="done")]
    FakeProvider.captured = {}
    for service in ("chat_service", "card_assistant", "memory_service"):
        monkeypatch.setattr(f"app.services.{service}.get_provider", FakeProvider)
    return FakeProvider


async def add_connection(client):
    return (await client.post("/api/connections", json={
        "name": "Mock", "provider": "openai-compatible",
        "base_url": "http://localhost:1234/v1", "model": "test",
    })).json()


APP_DIR = Path(app_package.__file__).parent


def test_every_raised_error_names_itself():
    """Every ``raise AppError(...)`` has a kind, and every ``raise NotFoundError(...)`` says what
    it did not find (its second argument)."""
    raised, unnamed = 0, []
    for path in sorted(APP_DIR.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not (isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call)):
                continue
            func = node.exc.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
            keywords = {keyword.arg for keyword in node.exc.keywords}
            named = {"AppError": "kind" in keywords or len(node.exc.args) >= 3,
                     "NotFoundError": "resource" in keywords or len(node.exc.args) >= 2}
            if name in named:
                raised += 1
                if not named[name]:
                    unnamed.append(f"{path.name}:{node.lineno}")
    # Otherwise the check would pass by looking at nothing.
    assert raised >= 30
    assert unnamed == []


NOT_FOUND = [
    ("get", "/api/characters/nope", None, "Character not found.", "character"),
    ("put", "/api/characters/nope", {"name": "x"}, "Character not found.", "character"),
    ("get", "/api/conversations/nope", None, "Conversation not found.", "conversation"),
    ("get", "/api/conversations/nope/memories", None, "Conversation not found.", "conversation"),
    ("post", "/api/conversations", {"character_id": "nope"}, "Character not found.", "character"),
    ("patch", "/api/messages/nope", {"content": "x"}, "Message not found.", "message"),
    ("post", "/api/messages/nope/branch", None, "Message not found.", "message"),
    ("put", "/api/personas/nope", {"name": "x"}, "Persona not found.", "persona"),
    ("delete", "/api/connections/nope", None, "Connection not found.", "connection"),
    ("patch", "/api/memories/nope", {"is_pinned": True}, "Fact not found.", "fact"),
    ("get", "/api/library/nope.json/avatar", None, "No illustration for this card.",
     "illustration"),
    ("get", "/api/media/nope.png", None, "File not found.", "file"),
]


@pytest.mark.parametrize(
    ("method", "url", "body", "message", "resource"), NOT_FOUND,
    ids=[f"{method} {url}" for method, url, *_ in NOT_FOUND],
)
async def test_a_missing_thing_is_not_found_and_says_which(
    client, method, url, body, message, resource,
):
    resp = await client.request(method, url, json=body)
    assert resp.status_code == 404, resp.text
    assert resp.json() == {"error": message, "kind": "not_found", "resource": resource}


async def test_an_upload_over_the_limit(client, monkeypatch):
    monkeypatch.setattr("app.services.media.MAX_UPLOAD_BYTES", 10)
    char = (await client.post("/api/characters", json={"name": "Vane"})).json()
    resp = await client.post(f"/api/characters/{char['id']}/avatar",
                             files={"file": ("x.png", b"x" * 11, "image/png")})
    assert resp.status_code == 413
    assert resp.json() == {"error": "File too large (15 MB max).", "kind": "file_too_large"}


async def test_an_image_format_that_is_not_accepted(client):
    char = (await client.post("/api/characters", json={"name": "Vane"})).json()
    resp = await client.post(f"/api/characters/{char['id']}/avatar",
                             files={"file": ("x.gif", b"GIF89a", "image/gif")})
    assert resp.status_code == 400
    assert resp.json() == {
        "error": "Unsupported image format (PNG, JPEG or WebP).",
        "kind": "unsupported_image",
    }


async def test_a_fact_that_is_already_known(client, provider):
    convo = await setup_conversation(client)
    url = f"/api/conversations/{convo['id']}/memories"
    resp = await client.post(url, json={"content": "She lies."})
    assert resp.status_code == 201
    resp = await client.post(url, json={"content": "She lies."})
    assert resp.status_code == 400
    assert resp.json() == {"error": "This fact already exists.", "kind": "fact_exists"}


async def test_no_connection_for_the_card_assistant(client, provider):
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 400
    assert resp.json()["kind"] == "no_connection"
    assert "connection" in resp.json()["error"].lower()


async def test_no_connection_for_the_story_tools(client, provider):
    char = (await client.post("/api/characters", json={"name": "X", "greeting": ""})).json()
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert resp.status_code == 400
    assert resp.json()["kind"] == "no_connection"


async def test_an_empty_conversation_for_the_story_tools(client, provider):
    convo = await setup_conversation(client, greeting="")
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert resp.status_code == 400
    assert resp.json()["kind"] == "conversation_empty"


async def test_a_model_that_reports_an_error(client, provider):
    convo = await setup_conversation(client)
    FakeProvider.script = [ProviderError("Rate limit reached (429).")]
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert resp.status_code == 502
    assert resp.json() == {"error": "Rate limit reached (429).", "kind": "model_error"}


async def test_a_model_that_says_nothing(client, provider):
    convo = await setup_conversation(client)
    FakeProvider.script = [ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert resp.status_code == 502
    assert resp.json()["kind"] == "model_empty"


async def test_a_card_the_model_wrote_badly(client, provider):
    await add_connection(client)
    provider.script = [ProviderEvent(type="delta", text="not json"),
                                 ProviderEvent(type="done")]
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 502
    assert resp.json() == {
        "error": "The model did not return a readable card. Try again.",
        "kind": "model_unreadable",
    }


@pytest.mark.parametrize("route", ["extract", "consolidate"])
async def test_a_memory_pass_without_a_connection(client, provider, route):
    char = (await client.post("/api/characters", json={"name": "X", "greeting": "Hi"})).json()
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/{route}")
    # The same status as everywhere else that finds no connection: it is for the person
    # to add one, which is no fault of a model's server.
    assert resp.status_code == 400
    assert resp.json()["kind"] == "no_connection"


async def test_a_turn_that_cannot_be_had_is_refused_by_name(client, provider):
    """Before anything is saved, as any refusal of the API is: the page keeps the message."""
    char = (await client.post("/api/characters", json={"name": "X", "greeting": ""})).json()
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()

    resp = await client.post("/api/chat", json={"conversation_id": convo["id"], "content": "Hi"})
    assert (resp.status_code, resp.json()["kind"]) == (400, "no_connection")

    resp = await client.post("/api/chat", json={"conversation_id": "nope", "content": "Hi"})
    assert resp.status_code == 404
    assert resp.json() == {"error": "Conversation not found.", "kind": "not_found",
                           "resource": "conversation"}


@pytest.mark.parametrize(("asked", "greeting", "kind"), [
    ({"mode": "send", "content": "   "}, "Hi.", "empty_message"),
    ({"mode": "regenerate"}, "Hi.", "nothing_to_regenerate"),
    ({"mode": "continue"}, "", "nothing_to_continue"),
])
async def test_a_turn_with_nothing_to_do_is_refused_by_name(client, provider, asked, greeting, kind):
    convo = await setup_conversation(client, greeting=greeting)
    resp = await client.post("/api/chat", json={"conversation_id": convo["id"], **asked})
    assert (resp.status_code, resp.json()["kind"]) == (400, kind)


async def test_a_reply_says_how_the_model_failed(client, provider):
    convo = await setup_conversation(client)
    FakeProvider.script = [ProviderError("boom")]
    assert await send(client, convo["id"]) == {"message": "boom", "kind": "model_error", "mode": "send"}
    FakeProvider.script = [ProviderError("http://localhost:1234/v1", "unreachable")]
    assert (await send(client, convo["id"]))["kind"] == "unreachable"


async def test_the_stream_names_a_reply_that_stays_empty(client, provider):
    convo = await setup_conversation(client, greeting="")
    FakeProvider.script = [ProviderEvent(type="done")]
    assert (await send(client, convo["id"]))["kind"] == "model_empty"


@pytest.mark.parametrize("saved", [False, True], ids=["before the message is saved", "after"])
async def test_a_crash_while_writing_a_reply_is_internal(client, provider, monkeypatch, saved):
    convo = await setup_conversation(client)

    async def crash(db, request, turn):
        if saved:
            turn.accepted.set()
        raise RuntimeError("disk on fire")

    monkeypatch.setattr("app.services.chat_service.run_turn", crash)
    resp = await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "send", "content": "Hi",
    })
    if saved:
        assert resp.status_code == 200
        state = (await client.get(f"/api/conversations/{convo['id']}/turn")).json()
        assert state["outcome"] == {"kind": "internal", "message": "disk on fire", "mode": "send"}
    else:
        assert resp.status_code == 500
        assert resp.json() == {"error": "disk on fire", "kind": "internal"}
