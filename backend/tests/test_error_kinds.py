"""Every error the API raises names itself with a ``kind``, so that the interface
can say it in the person's own language. The English ``error`` sentence stays
for clients that read it."""

import ast
import json
from pathlib import Path

import pytest

import app as app_package
from app.providers.base import ProviderError, ProviderEvent

from .test_cards import make_minimal_png
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


@pytest.mark.parametrize("entry", [
    {"keys": [], "content": "It is shut."},
    {"keys": ["crypt"], "content": ""},
])
async def test_a_lore_entry_with_nothing_in_a_field_is_incomplete_too(client, entry):
    char = (await client.post("/api/characters", json={"name": "Vane"})).json()
    resp = await client.post(f"/api/characters/{char['id']}/lore", json=entry)
    assert resp.status_code == 400
    assert resp.json()["kind"] == "lore_entry_incomplete"


async def _lore_entry(client):
    char = (await client.post("/api/characters", json={"name": "Vane"})).json()
    entry = (await client.post(f"/api/characters/{char['id']}/lore",
                               json={"keys": ["crypt", "seal"], "content": "It is shut."})).json()
    return entry


@pytest.mark.parametrize("patch", [
    {"keys": []},
    {"keys": [" ", ""]},
    {"content": ""},
    {"content": "  \n "},
    {"keys": [], "content": "Still something."},
    {"keys": ["crypt"], "content": " "},
])
async def test_a_lore_entry_cannot_be_edited_into_an_incomplete_one(client, patch):
    entry = await _lore_entry(client)

    resp = await client.patch(f"/api/lore/{entry['id']}", json=patch)

    assert resp.status_code == 400
    assert resp.json() == {
        "error": "An entry needs at least one keyword and some content.",
        "kind": "lore_entry_incomplete",
    }
    char_lore = (await client.get(f"/api/characters/{entry['character_id']}/lore")).json()
    assert [(e["keys"], e["content"]) for e in char_lore] == [(["crypt", "seal"], "It is shut.")]


async def test_a_lore_entry_can_still_be_edited_in_part(client):
    entry = await _lore_entry(client)

    toggled = await client.patch(f"/api/lore/{entry['id']}", json={"enabled": False})
    rekeyed = await client.patch(f"/api/lore/{entry['id']}",
                                 json={"keys": [" vault ", " ", "door"], "content": " Open. "})
    ignored = await client.patch(f"/api/lore/{entry['id']}", json={"keys": None, "content": None})

    assert toggled.status_code == 200 and toggled.json()["enabled"] is False
    assert rekeyed.status_code == 200
    assert (rekeyed.json()["keys"], rekeyed.json()["content"]) == (["vault", "door"], "Open.")
    assert ignored.status_code == 200
    assert (ignored.json()["keys"], ignored.json()["content"]) == (["vault", "door"], "Open.")


async def test_a_library_card_that_is_already_installed(client, tmp_path, monkeypatch):
    shelf = tmp_path / "shelf"
    shelf.mkdir()
    (shelf / "vane.json").write_text(json.dumps({"name": "Vane", "description": "x"}),
                                     encoding="utf-8")
    monkeypatch.setenv("EVERMIND_LIBRARY_DIR", str(shelf))
    resp = await client.post("/api/library/vane.json/install")
    assert resp.status_code == 201
    resp = await client.post("/api/library/vane.json/install")
    assert resp.status_code == 400
    assert resp.json() == {"error": "This card is already installed.", "kind": "already_installed"}


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
    FakeProvider.script = [ProviderError("Rate limit reached (429).")]
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert resp.status_code == 502
    assert resp.json() == {"error": "Rate limit reached (429).", "kind": "model_error"}


async def test_a_model_that_cannot_be_reached_keeps_its_own_kind(client, provider):
    convo = await setup_conversation(client)
    FakeProvider.script = [ProviderError("http://localhost:1234/v1", "unreachable")]
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert resp.status_code == 502
    assert resp.json() == {"error": "http://localhost:1234/v1", "kind": "unreachable"}


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
    provider.script = [ProviderError("Overloaded.")]
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
    FakeProvider.script = [ProviderError("Quota exceeded.")]
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
