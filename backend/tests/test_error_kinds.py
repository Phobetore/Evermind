"""Every error the API raises names itself with a ``kind``, so that the interface
can say it in the person's own language. The English ``error`` sentence stays
for clients that read it."""

import ast
from pathlib import Path

import pytest

import app as app_package
from app.providers.base import ProviderEvent

from .test_chat import FakeProvider, send, setup_conversation


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


def _raised_errors():
    """Every ``raise AppError(...)`` and ``raise NotFoundError(...)`` in the
    application, as (file, line, class name, call)."""
    for path in sorted(APP_DIR.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not (isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call)):
                continue
            func = node.exc.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
            if name in ("AppError", "NotFoundError"):
                yield path.name, node.lineno, name, node.exc


def test_the_application_raises_errors():
    # Otherwise the check below would pass by looking at nothing.
    assert len(list(_raised_errors())) >= 30


@pytest.mark.parametrize(
    ("file", "line", "name", "call"),
    list(_raised_errors()),
    ids=lambda value: value if isinstance(value, str | int) else "",
)
def test_every_raised_error_names_itself(file, line, name, call):
    keywords = {keyword.arg for keyword in call.keywords}
    if name == "NotFoundError":
        # The second argument is what was not found.
        assert len(call.args) >= 2 or "resource" in keywords, (
            f"{file}:{line} NotFoundError without a resource"
        )
    else:
        assert "kind" in keywords or len(call.args) >= 3, f"{file}:{line} AppError without a kind"


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


async def test_a_variant_that_does_not_exist(client, provider):
    convo = await setup_conversation(client)
    message = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"][0]
    resp = await client.patch(f"/api/messages/{message['id']}", json={"active_index": 9})
    assert resp.status_code == 400
    assert resp.json() == {
        "error": "Variant index out of range.", "kind": "variant_out_of_range",
    }


async def test_a_fact_that_is_already_known(client, provider):
    convo = await setup_conversation(client)
    url = f"/api/conversations/{convo['id']}/memories"
    resp = await client.post(url, json={"content": "She lies."})
    assert resp.status_code == 201
    resp = await client.post(url, json={"content": "She lies."})
    assert resp.status_code == 400
    assert resp.json() == {"error": "This fact already exists.", "kind": "fact_exists"}


@pytest.mark.parametrize("content", ["", "   ", "\n\t"])
async def test_a_fact_without_text_is_not_a_fact_that_exists(client, provider, content):
    convo = await setup_conversation(client)
    resp = await client.post(f"/api/conversations/{convo['id']}/memories",
                             json={"content": content})
    assert resp.status_code == 400
    assert resp.json() == {"error": "A fact needs some text.", "kind": "fact_empty"}
    assert (await client.get(f"/api/conversations/{convo['id']}/memories")).json() == []


@pytest.mark.parametrize("content", ["", "   "])
async def test_a_fact_cannot_be_edited_into_nothing(client, provider, content):
    convo = await setup_conversation(client)
    url = f"/api/conversations/{convo['id']}/memories"
    fact = (await client.post(url, json={"content": "She lies."})).json()

    resp = await client.patch(f"/api/memories/{fact['id']}", json={"content": content})

    assert resp.status_code == 400
    assert resp.json() == {"error": "A fact needs some text.", "kind": "fact_empty"}
    assert (await client.get(url)).json()[0]["content"] == "She lies."


async def test_a_fact_can_still_be_pinned_or_rewritten(client, provider):
    convo = await setup_conversation(client)
    url = f"/api/conversations/{convo['id']}/memories"
    fact = (await client.post(url, json={"content": "She lies."})).json()

    pinned = await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": True})
    rewritten = await client.patch(f"/api/memories/{fact['id']}", json={"content": " She tells the truth. "})

    assert pinned.status_code == 200 and pinned.json()["is_pinned"] is True
    assert rewritten.status_code == 200 and rewritten.json()["content"] == "She tells the truth."


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


async def test_a_missing_conversation_for_the_story_tools(client, provider):
    resp = await client.post("/api/conversations/nope/impersonate")
    assert resp.status_code == 404
    assert resp.json() == {
        "error": "Conversation not found.", "kind": "not_found", "resource": "conversation",
    }


async def test_an_empty_conversation_for_the_story_tools(client, provider):
    convo = await setup_conversation(client, greeting="")
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert resp.status_code == 400
    assert resp.json()["kind"] == "conversation_empty"


async def test_a_model_that_reports_an_error(client, provider):
    convo = await setup_conversation(client)
    FakeProvider.script = [ProviderEvent(type="error", message="Rate limit reached (429).")]
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert resp.status_code == 502
    assert resp.json() == {"error": "Rate limit reached (429).", "kind": "model_error"}


async def test_a_model_that_cannot_be_reached_keeps_its_own_kind(client, provider):
    convo = await setup_conversation(client)
    FakeProvider.script = [
        ProviderEvent(type="error", message="Cannot reach it.", meta={"kind": "unreachable"}),
    ]
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert resp.status_code == 502
    assert resp.json() == {"error": "Cannot reach it.", "kind": "unreachable"}


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


async def test_a_card_the_model_left_empty(client, provider):
    await add_connection(client)
    provider.script = [ProviderEvent(type="delta", text='{"nothing": 1}'),
                                 ProviderEvent(type="done")]
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 502
    assert resp.json() == {
        "error": "The model returned an empty card. Try again.", "kind": "model_empty",
    }


async def test_a_model_error_while_writing_a_card(client, provider):
    await add_connection(client)
    provider.script = [ProviderEvent(type="error", message="Overloaded.")]
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 502
    assert resp.json() == {"error": "Overloaded.", "kind": "model_error"}


@pytest.mark.parametrize("route", ["extract", "consolidate"])
async def test_a_memory_pass_without_a_connection(client, provider, route):
    char = (await client.post("/api/characters", json={"name": "X", "greeting": "Hi"})).json()
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/{route}")
    # The same status as everywhere else that finds no connection: it is for the person
    # to add one, which is no fault of a model's server.
    assert resp.status_code == 400
    assert resp.json()["kind"] == "no_connection"


async def _conversation_with_facts_to_merge(client):
    """A conversation both memory passes have something to work on in: it has
    been talked in, and holds enough facts of the kind consolidation moves."""
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    for number in range(10):
        await client.post(f"/api/conversations/{convo['id']}/memories",
                          json={"content": f"Fact number {number}."})
    from app.db import _connect

    db = await _connect()
    await db.execute("UPDATE memories SET source='auto'")
    await db.commit()
    await db.close()
    return convo


@pytest.mark.parametrize("route", ["extract", "consolidate"])
async def test_a_memory_pass_the_model_answers_badly(client, provider, route):
    convo = await _conversation_with_facts_to_merge(client)
    FakeProvider.script = [ProviderEvent(type="delta", text="no json here"),
                           ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/{route}")
    assert resp.status_code == 502
    assert resp.json()["kind"] == "model_unreadable"


@pytest.mark.parametrize("route", ["extract", "consolidate"])
async def test_a_memory_pass_the_model_refuses(client, provider, route):
    convo = await _conversation_with_facts_to_merge(client)
    FakeProvider.script = [ProviderEvent(type="error", message="Quota exceeded.")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/{route}")
    assert resp.status_code == 502
    assert resp.json() == {"error": "Quota exceeded.", "kind": "model_error"}


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


async def test_the_stream_gives_a_failing_model_a_kind(client, provider):
    convo = await setup_conversation(client)
    FakeProvider.script = [ProviderEvent(type="error", message="boom")]
    assert await send(client, convo["id"]) == {"message": "boom", "kind": "model_error", "mode": "send"}


async def test_the_stream_keeps_a_kind_the_model_gave(client, provider):
    convo = await setup_conversation(client)
    FakeProvider.script = [
        ProviderEvent(type="error", message="Cannot reach it.", meta={"kind": "unreachable"}),
    ]
    assert (await send(client, convo["id"]))["kind"] == "unreachable"


async def test_the_stream_names_a_reply_that_stays_empty(client, provider):
    convo = await setup_conversation(client, greeting="")
    FakeProvider.script = [ProviderEvent(type="done")]
    assert (await send(client, convo["id"]))["kind"] == "model_empty"


async def test_the_stream_names_a_reply_that_stayed_empty_after_a_second_try(
    client, provider,
):
    """With the greeting as the first message, the turn is tried again with it
    moved out of the way, and the sentence says so."""
    convo = await setup_conversation(client)
    FakeProvider.script = [ProviderEvent(type="done")]
    assert (await send(client, convo["id"]))["kind"] == "model_empty_retried"


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
