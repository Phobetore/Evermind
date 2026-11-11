"""Card assistant tests (mocked provider)."""

import json
import logging

import pytest

from app.providers.base import ProviderError, ProviderEvent

from .conftest import FakeProvider

CARD_JSON = json.dumps({
    "name": "Nyra",
    "tagline": "La cartographe des futurs.",
    "description": "She draws prophetic cards for {{user}}.",
    "personality": "mischievous, enigmatic",
    "scenario": "{{user}} enters the shop.",
    "greeting": "*She looks up.* Well, {{user}}.",
    "alternate_greetings": ["*The shop is empty.*"],
    "example_dialogues": "<START>\n{{user}}: Fiable ?\n{{char}}: Autant que toi.",
    "tags": ["Fantasy", "Mystery"],
})


@pytest.fixture()
def fake_provider(monkeypatch):
    FakeProvider.script = [ProviderEvent(type="delta", text=CARD_JSON), ProviderEvent(type="done")]
    FakeProvider.captured = {}
    monkeypatch.setattr("app.services.card_assistant.get_provider", FakeProvider)
    return FakeProvider


async def add_connection(client, **fields):
    return (await client.post("/api/connections", json={
        "name": "Mock", "provider": "openai-compatible",
        "base_url": "http://localhost:1234/v1", "model": "test", **fields,
    })).json()


async def test_assist_returns_clean_draft(client, fake_provider):
    await add_connection(client)
    resp = await client.post("/api/characters/assist", json={
        "prompt": "A mysterious cartographer who sells prophetic cards",
    })
    assert resp.status_code == 200, resp.text
    draft = resp.json()
    assert draft["name"] == "Nyra"
    assert draft["tags"] == ["fantasy", "mystery"]  # lowercased
    assert draft["alternate_greetings"] == ["*The shop is empty.*"]
    payload = fake_provider.captured["payload"]
    assert "card-writer" in payload.system
    assert "CHARACTER" in payload.messages[0]["content"]


async def test_assist_scenario_kind_and_existing_preserved(client, fake_provider):
    await add_connection(client)
    resp = await client.post("/api/characters/assist", json={
        "prompt": "A sunken city full of secrets",
        "kind": "scenario",
        "existing": {"name": "The Sunken City", "tags": ["adventure"]},
    })
    assert resp.status_code == 200
    draft = resp.json()
    # creator's fields win over the model's
    assert draft["name"] == "The Sunken City"
    assert draft["tags"] == ["adventure"]
    content = fake_provider.captured["payload"].messages[0]["content"]
    assert "SCENARIO" in content
    assert "EXISTING FIELDS" in content


async def test_assist_without_connection_fails_readably(client, fake_provider):
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 400
    assert "connection" in resp.json()["error"].lower()


async def test_assist_unreadable_reply_502(client, fake_provider):
    await add_connection(client)
    fake_provider.script = [ProviderEvent(type="delta", text="not json"),
                            ProviderEvent(type="done")]
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 502


async def test_assist_repairs_rp_model_json(client, fake_provider):
    """Literal newlines in strings + fence + chatter: the real Cydonia case."""
    await add_connection(client)
    messy = ('Voici votre fiche :\n```json\n{\n"name": "Kenji Sato",\n'
             '"greeting": "*Rain falls on Kabukicho.*\nTu n\'es personne, {{user}}.",\n'
             '"tags": ["yakuza", "realistic"],\n}\n```\nHave a good game!')
    fake_provider.script = [ProviderEvent(type="delta", text=messy), ProviderEvent(type="done")]
    resp = await client.post("/api/characters/assist", json={"prompt": "japanese gangster"})
    assert resp.status_code == 200, resp.text
    draft = resp.json()
    assert draft["name"] == "Kenji Sato"
    assert "Kabukicho" in draft["greeting"]


@pytest.mark.parametrize(("ceiling", "sent"), [(512, 2048), (4096, 4096), (None, None)])
async def test_assist_raises_only_a_ceiling_the_connection_has(client, fake_provider,
                                                               ceiling, sent):
    await add_connection(client, max_tokens=ceiling)
    await client.post("/api/characters/assist", json={"prompt": "japanese gangster"})
    assert fake_provider.captured["connection"]["max_tokens"] == sent


async def test_assist_returns_lore_entries(client, fake_provider):
    await add_connection(client)
    with_lore = json.dumps({
        "name": "Kenji", "tagline": "\ud800",
        "lore_entries": [
            {"keys": ["Kabukicho", "kabukicho"], "content": "The red-light district of Shinjuku."},
            {"keys": ["clan Sato", "\ud800"], "content": "The family that runs the docks."},
            {"keys": [], "content": "Entry with no keyword, to discard."},
            {"keys": ["vide"], "content": "   "},
            "not an object",
        ],
    })
    fake_provider.script = [ProviderEvent(type="delta", text=with_lore), ProviderEvent(type="done")]
    draft = (await client.post("/api/characters/assist", json={"prompt": "yakuza"})).json()
    assert len(draft["lore_entries"]) == 2  # invalid entries filtered out
    assert draft["lore_entries"][0]["keys"] == ["Kabukicho", "kabukicho"]
    assert "Shinjuku" in draft["lore_entries"][0]["content"]
    # A lone surrogate, which an escape in the answer gives, cannot be written to the response.
    assert "tagline" not in draft and draft["lore_entries"][1]["keys"] == ["clan Sato"]


async def test_assist_avoids_duplicating_existing_lore(client, fake_provider):
    await add_connection(client)
    await client.post("/api/characters/assist", json={
        "prompt": "yakuza",
        "existing": {"lore_entries": [{"keys": ["Kabukicho"], "content": "already written"}]},
    })
    content = fake_provider.captured["payload"].messages[0]["content"]
    assert "EXISTING LOREBOOK KEYWORDS" in content
    assert "Kabukicho" in content


async def test_assist_reads_lore_entries_from_a_list_only_and_their_keys_as_a_drafts(
        client, fake_provider):
    """A lorebook that is no list holds no entry, and fails no request. The keys of an entry
    are read as a draft's are: a bare string is one keyword, a number or an object none."""
    await add_connection(client)
    for existing in ({"lore_entries": 5}, {"lore_entries": "Kabukicho"},
                     {"lore_entries": {"keys": ["Kabukicho"], "content": "c"}},
                     {"lore_entries": True}):
        drafted = json.dumps({"name": "Kenji", **existing})
        fake_provider.script = [ProviderEvent(type="delta", text=drafted), ProviderEvent(type="done")]
        resp = await client.post("/api/characters/assist", json={
            "prompt": "yakuza", "existing": existing})
        assert resp.status_code == 200, (existing, resp.text)
        content = fake_provider.captured["payload"].messages[0]["content"]
        assert "EXISTING LOREBOOK KEYWORDS" not in content, existing

    resp = await client.post("/api/characters/assist", json={
        "prompt": "yakuza",
        "existing": {"lore_entries": [
            {"keys": "Kabukicho"}, {"keys": 5}, {"keys": {"Shinjuku": 1}}, {"keys": None},
            {"keys": ["clan"]},
        ]},
    })
    assert resp.status_code == 200, resp.text
    content = fake_provider.captured["payload"].messages[0]["content"]
    assert "EXISTING LOREBOOK KEYWORDS (cover other subjects):\nKabukicho, clan\n" in content


def warnings_of(caplog):
    return [r for r in caplog.records if r.levelno == logging.WARNING]


async def test_a_failed_model_server_is_logged_with_its_kind_and_status(
        client, fake_provider, caplog):
    await add_connection(client)
    fake_provider.script = [ProviderError("Invalid key", "model_auth_refused", 401)]
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 502
    [line] = warnings_of(caplog)
    assert line.getMessage() == ("POST /api/characters/assist failed with model_auth_refused: "
                                 "Invalid key (the model's server answered 401)")
    assert line.exc_info is None


async def test_an_unreadable_card_is_logged_with_the_length_and_end_of_the_answer(
        client, fake_provider, caplog):
    await add_connection(client)
    cut = '{"name": "Nyra",\n"description": "She draws cards for ' + "x" * 200
    fake_provider.script = [ProviderEvent(type="delta", text=cut), ProviderEvent(type="done")]
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 502
    unreadable, failed = warnings_of(caplog)
    assert unreadable.getMessage() == (
        f'card assistant: unreadable answer, {len(cut)} characters, ends with "{"x" * 80}"')
    assert "model_unreadable" in failed.getMessage()
    assert all(r.exc_info is None for r in caplog.records)
    assert "She draws cards" not in caplog.text, "only the end of an answer is logged"


async def test_a_newline_in_the_end_of_an_answer_stays_on_one_line(client, fake_provider, caplog):
    await add_connection(client)
    fake_provider.script = [ProviderEvent(type="delta", text="Sorry,\nI cannot."),
                            ProviderEvent(type="done")]
    await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    [line, _] = warnings_of(caplog)
    assert line.getMessage().endswith('16 characters, ends with "Sorry,\\nI cannot."')


async def test_an_error_under_500_leaves_nothing_in_the_log(client, fake_provider, caplog):
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 400
    assert warnings_of(caplog) == []
