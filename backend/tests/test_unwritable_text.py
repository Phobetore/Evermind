"""Half of an emoji, a lone surrogate, comes in JSON as an escape such as \\ud83d, and can be neither
stored nor sent. Every route that takes text refuses it with a 422 naming the field, never a 500,
and nothing is written."""

import json

import pytest

from .conftest import messages_of, setup_conversation

BROKEN = "She smiles \ud83d"


async def ask(client, method: str, url: str, body: dict):
    # What a browser's JSON.stringify sends, which the test client's own encoder would refuse.
    return await client.request(method, url, content=json.dumps(body),
                                headers={"content-type": "application/json"})


@pytest.fixture()
async def made(client):
    convo = await setup_conversation(client)
    character = (await client.get(f"/api/characters/{convo['character_id']}")).json()
    return {
        "character": character["id"],
        "persona": (await client.get("/api/personas")).json()[0]["id"],
        "connection": (await client.get("/api/connections")).json()[0]["id"],
        "conversation": convo["id"],
        "message": (await messages_of(client, convo["id"]))[0]["id"],
    }


ROUTES = [
    ("POST", "/api/characters", {"name": "Lone", "description": BROKEN}, ["description"]),
    ("POST", "/api/characters", {"name": BROKEN}, ["name"]),
    ("POST", "/api/characters", {"name": "Lone", "tags": ["ok", BROKEN]}, ["tags"]),
    ("POST", "/api/characters", {"name": "Lone", "lore_entries": [{"keys": ["k"], "content": BROKEN}]},
     ["lore_entries", 0, "content"]),
    ("POST", "/api/characters", {"name": "Lone", "lore_entries": [{"keys": [BROKEN], "content": "c"}]},
     ["lore_entries", 0, "keys"]),
    ("PUT", "/api/characters/{character}", {"description": BROKEN}, ["description"]),
    ("PUT", "/api/characters/{character}", {"alternate_greetings": [BROKEN]}, ["alternate_greetings"]),
    ("POST", "/api/personas", {"name": "Sam", "description": BROKEN}, ["description"]),
    ("PUT", "/api/personas/{persona}", {"description": BROKEN}, ["description"]),
    ("POST", "/api/connections", {"name": "Other", "model": BROKEN}, ["model"]),
    ("PUT", "/api/connections/{connection}", {"name": "Local", "model": BROKEN}, ["model"]),
    ("POST", "/api/connections/test", {"name": "Local", "base_url": BROKEN}, ["base_url"]),
    ("PATCH", "/api/conversations/{conversation}", {"title": BROKEN}, ["title"]),
    ("PATCH", "/api/conversations/{conversation}", {"summary": BROKEN}, ["summary"]),
    ("PATCH", "/api/conversations/{conversation}", {"author_note": BROKEN}, ["author_note"]),
    ("PATCH", "/api/messages/{message}", {"content": BROKEN}, ["content"]),
    ("PUT", "/api/settings", {"global_instructions": BROKEN}, ["global_instructions"]),
    ("POST", "/api/conversations/{conversation}/memories", {"content": BROKEN}, ["content"]),
    ("POST", "/api/chat", {"conversation_id": "{conversation}", "content": BROKEN}, ["content"]),
    ("POST", "/api/characters/assist", {"prompt": f"A {BROKEN}"}, ["prompt"]),
]


@pytest.mark.parametrize(("method", "url", "body", "field"), ROUTES)
async def test_a_text_with_half_of_an_emoji_is_refused_by_name(client, made, method, url, body, field):
    before = [(await client.get(f"/api/{what}")).json()
              for what in ("characters", "personas", "connections", "settings")]
    filled = json.loads(json.dumps(body).replace("{conversation}", made["conversation"]))

    resp = await ask(client, method, url.format(**made), filled)

    assert resp.status_code == 422, resp.text
    assert [error["loc"] for error in resp.json()["detail"]] == [["body", *field]]
    assert [(await client.get(f"/api/{what}")).json()
            for what in ("characters", "personas", "connections", "settings")] == before


async def test_nothing_of_the_conversation_changes(client, made):
    convo = f"/api/conversations/{made['conversation']}"
    before = (await client.get(convo)).json()

    for body in ({"title": BROKEN}, {"summary": BROKEN}):
        await ask(client, "PATCH", convo, body)
    await ask(client, "PATCH", f"/api/messages/{made['message']}", {"content": BROKEN})
    await ask(client, "POST", "/api/chat", {"conversation_id": made["conversation"], "content": BROKEN})

    assert (await client.get(convo)).json() == before


async def test_a_whole_emoji_is_stored_as_it_is(client):
    resp = await ask(client, "POST", "/api/characters", {"name": "Whole", "description": "She smiles \U0001F600"})

    assert resp.status_code == 201
    assert resp.json()["description"] == "She smiles \U0001F600"
