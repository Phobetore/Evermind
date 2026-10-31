"""Every error the API raises names itself with a ``kind``, so that the interface
can say it in the person's own language. The English ``error`` sentence stays
for clients that read it."""

import ast
import json
from pathlib import Path

import pytest

import app as app_package
from app.providers.base import ProviderEvent

from .test_cards import make_minimal_png
from .test_chat import FakeProvider, parse_sse, send, setup_conversation


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
    ("post", "/api/connections/nope/test", None, "Connection not found.", "connection"),
    ("patch", "/api/lore/nope", {"enabled": False}, "Entry not found.", "lore_entry"),
    ("post", "/api/characters/nope/lore", {"keys": ["a"], "content": "b"},
     "Character not found.", "character"),
    ("patch", "/api/memories/nope", {"is_pinned": True}, "Fact not found.", "fact"),
    ("post", "/api/library/nope.json/install", None, "Card not found in the library.",
     "library_card"),
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


async def test_other_errors_carry_no_resource(client):
    resp = await client.post("/api/characters/import",
                             files={"file": ("x.txt", b"not a card", "text/plain")})
    assert resp.status_code == 400
    assert "resource" not in resp.json()


async def test_a_png_without_a_card(client):
    resp = await client.post("/api/characters/import",
                             files={"file": ("x.png", make_minimal_png(), "image/png")})
    assert resp.status_code == 400
    assert resp.json() == {
        "error": 'This PNG does not contain a character card (no "chara" chunk).',
        "kind": "png_without_card",
    }


async def test_a_file_that_is_no_card(client):
    resp = await client.post("/api/characters/import",
                             files={"file": ("x.json", b"not json", "application/json")})
    assert resp.status_code == 400
    assert resp.json() == {
        "error": "Unrecognized file: provide a JSON card or a card PNG.",
        "kind": "unrecognized_card_file",
    }


async def test_an_upload_over_the_limit(client, monkeypatch):
    monkeypatch.setattr("app.services.media.MAX_UPLOAD_BYTES", 10)
    resp = await client.post("/api/characters/import",
                             files={"file": ("x.json", b"x" * 11, "application/json")})
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


async def test_a_lore_entry_without_keywords_or_content(client):
    char = (await client.post("/api/characters", json={"name": "Vane"})).json()
    resp = await client.post(f"/api/characters/{char['id']}/lore",
                             json={"keys": [" "], "content": "It is shut."})
    assert resp.status_code == 400
    assert resp.json() == {
        "error": "An entry needs at least one keyword and some content.",
        "kind": "lore_entry_incomplete",
    }


async def test_a_fact_that_is_already_known(client, provider):
    convo = await setup_conversation(client)
    url = f"/api/conversations/{convo['id']}/memories"
    assert (await client.post(url, json={"content": "She lies."})).status_code == 201
    resp = await client.post(url, json={"content": "She lies."})
    assert resp.status_code == 400
    assert resp.json() == {"error": "This fact already exists.", "kind": "fact_exists"}


async def test_a_library_card_that_is_already_installed(client, tmp_path, monkeypatch):
    shelf = tmp_path / "shelf"
    shelf.mkdir()
    (shelf / "vane.json").write_text(json.dumps({"name": "Vane", "description": "x"}),
                                     encoding="utf-8")
    monkeypatch.setenv("EVERMIND_LIBRARY_DIR", str(shelf))
    assert (await client.post("/api/library/vane.json/install")).status_code == 201
    resp = await client.post("/api/library/vane.json/install")
    assert resp.status_code == 400
    assert resp.json() == {"error": "This card is already installed.", "kind": "already_installed"}


async def test_no_connection_for_the_card_assistant(client, provider):
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 400
    assert resp.json()["kind"] == "no_connection"
    assert "connection" in resp.json()["error"].lower()


@pytest.mark.parametrize("route", ["impersonate", "summarize"])
async def test_no_connection_for_the_story_tools(client, provider, route):
    char = (await client.post("/api/characters", json={"name": "X", "greeting": ""})).json()
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    resp = await client.post(f"/api/conversations/{convo['id']}/{route}")
    assert resp.status_code == 400
    assert resp.json()["kind"] == "no_connection"


@pytest.mark.parametrize("route", ["impersonate", "summarize"])
async def test_a_missing_conversation_for_the_story_tools(client, provider, route):
    resp = await client.post(f"/api/conversations/nope/{route}")
    assert resp.status_code == 400
    assert resp.json() == {
        "error": "Conversation not found.", "kind": "not_found", "resource": "conversation",
    }


@pytest.mark.parametrize("route", ["impersonate", "summarize"])
async def test_an_empty_conversation_for_the_story_tools(client, provider, route):
    convo = await setup_conversation(client, greeting="")
    resp = await client.post(f"/api/conversations/{convo['id']}/{route}")
    assert resp.status_code == 400
    assert resp.json()["kind"] == "conversation_empty"


@pytest.mark.parametrize("route", ["impersonate", "summarize"])
async def test_a_model_that_reports_an_error(client, provider, route):
    convo = await setup_conversation(client)
    FakeProvider.script = [ProviderEvent(type="error", message="Rate limit reached (429).")]
    resp = await client.post(f"/api/conversations/{convo['id']}/{route}")
    assert resp.status_code == 502
    assert resp.json() == {"error": "Rate limit reached (429).", "kind": "model_error"}


@pytest.mark.parametrize("route", ["impersonate", "summarize"])
async def test_a_model_that_cannot_be_reached_keeps_its_own_kind(client, provider, route):
    convo = await setup_conversation(client)
    FakeProvider.script = [
        ProviderEvent(type="error", message="Cannot reach it.", meta={"kind": "unreachable"}),
    ]
    resp = await client.post(f"/api/conversations/{convo['id']}/{route}")
    assert resp.status_code == 502
    assert resp.json() == {"error": "Cannot reach it.", "kind": "unreachable"}


@pytest.mark.parametrize("route", ["impersonate", "summarize"])
async def test_a_model_that_says_nothing(client, provider, route):
    convo = await setup_conversation(client)
    FakeProvider.script = [ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/{route}")
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
    assert resp.status_code == 502
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


async def test_the_stream_names_what_went_wrong_too(client, provider):
    """The same sentences travel as events of a reply, where they would
    otherwise reach the screen in English whatever the language chosen."""
    char = (await client.post("/api/characters", json={"name": "X", "greeting": ""})).json()
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()

    events = await send(client, convo["id"])
    assert events[-1]["kind"] == "no_connection"

    events = await send(client, "nope")
    assert events[-1] == {
        "type": "error", "message": "Conversation not found.", "kind": "not_found",
        "resource": "conversation",
    }


async def test_the_stream_refuses_an_empty_message_by_name(client, provider):
    convo = await setup_conversation(client)
    events = await send(client, convo["id"], content="   ")
    assert events[-1]["kind"] == "empty_message"


async def test_the_stream_names_a_regeneration_with_nothing_to_regenerate(client, provider):
    convo = await setup_conversation(client)
    events = await send(client, convo["id"], content=None, mode="regenerate")
    assert events[-1]["kind"] == "nothing_to_regenerate"


async def test_the_stream_names_a_continuation_with_nothing_to_continue(client, provider):
    convo = await setup_conversation(client, greeting="")
    events = await send(client, convo["id"], content=None, mode="continue")
    assert events[-1]["kind"] == "nothing_to_continue"


async def test_the_stream_gives_a_failing_model_a_kind(client, provider):
    convo = await setup_conversation(client)
    FakeProvider.script = [ProviderEvent(type="error", message="boom")]
    events = await send(client, convo["id"])
    assert events[-1] == {"type": "error", "message": "boom", "kind": "model_error"}


async def test_the_stream_keeps_a_kind_the_model_gave(client, provider):
    convo = await setup_conversation(client)
    FakeProvider.script = [
        ProviderEvent(type="error", message="Cannot reach it.", meta={"kind": "unreachable"}),
    ]
    events = await send(client, convo["id"])
    assert events[-1]["kind"] == "unreachable"


async def test_the_stream_names_a_reply_that_stays_empty(client, provider):
    convo = await setup_conversation(client, greeting="")
    FakeProvider.script = [ProviderEvent(type="done")]
    events = await send(client, convo["id"])
    assert events[-1]["kind"] == "model_empty"


async def test_the_stream_names_a_reply_that_stayed_empty_after_a_second_try(
    client, provider,
):
    """With the greeting as the first message, the turn is tried again with it
    moved out of the way, and the sentence says so."""
    convo = await setup_conversation(client)
    FakeProvider.script = [ProviderEvent(type="done")]
    events = await send(client, convo["id"])
    assert events[-1]["kind"] == "model_empty_retried"


async def test_a_crash_while_writing_a_reply_is_internal(client, provider, monkeypatch):
    convo = await setup_conversation(client)

    async def crash(*args, **kwargs):
        raise RuntimeError("disk on fire")
        yield  # pragma: no cover

    monkeypatch.setattr("app.services.chat_service.stream_turn", crash)
    resp = await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "send", "content": "Hi",
    })
    assert parse_sse(resp.text)[-1] == {
        "type": "error", "message": "disk on fire", "kind": "internal",
    }
