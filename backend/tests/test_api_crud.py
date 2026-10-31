"""API CRUD tests: characters (+import/export/avatar), personas, connections,
conversations (+greeting seeding), settings."""

import json
import re
from urllib.parse import unquote

import pytest

from .test_cards import CHAR_FIELDS, make_minimal_png


async def create_character(client, **overrides):
    payload = {"name": "Serana", "greeting": "*She stirs.* Hello {{user}}.", **overrides}
    resp = await client.post("/api/characters", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------- characters ----------

async def test_character_crud_and_filters(client):
    a = await create_character(client, tags=["fantasy"], kind="character")
    b = await create_character(client, name="The Drowned City", kind="scenario", tags=["mystery"])

    listed = (await client.get("/api/characters")).json()
    assert {c["name"] for c in listed} == {"Serana", "The Drowned City"}

    only_scenarios = (await client.get("/api/characters", params={"kind": "scenario"})).json()
    assert [c["id"] for c in only_scenarios] == [b["id"]]

    by_query = (await client.get("/api/characters", params={"q": "sera"})).json()
    assert [c["id"] for c in by_query] == [a["id"]]

    by_tag = (await client.get("/api/characters", params={"tag": "mystery"})).json()
    assert [c["id"] for c in by_tag] == [b["id"]]

    updated = await client.put(f"/api/characters/{a['id']}", json={"tagline": "Vampire lady"})
    assert updated.status_code == 200
    assert updated.json()["tagline"] == "Vampire lady"
    assert updated.json()["name"] == "Serana"  # partial update keeps other fields

    deleted = await client.delete(f"/api/characters/{a['id']}")
    assert deleted.status_code == 204
    gone = await client.get(f"/api/characters/{a['id']}")
    assert gone.status_code == 404


async def test_character_import_json_v2(client):
    card = {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {"name": "Imported", "description": "d", "first_mes": "hi", "tags": ["x"]},
    }
    files = {"file": ("card.json", json.dumps(card).encode(), "application/json")}
    resp = await client.post("/api/characters/import", files=files)
    assert resp.status_code == 201, resp.text
    assert resp.json()["name"] == "Imported"
    assert resp.json()["greeting"] == "hi"


async def test_character_import_png_sets_avatar(client):
    from app.cards.codec import character_to_card
    from app.cards.png import write_card_to_png

    png = write_card_to_png(make_minimal_png(), character_to_card(CHAR_FIELDS))
    files = {"file": ("serana.png", png, "image/png")}
    resp = await client.post("/api/characters/import", files=files)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "Serana"
    assert body["avatar_url"], "PNG import should set the avatar"
    media = await client.get(body["avatar_url"])
    assert media.status_code == 200
    assert media.content.startswith(b"\x89PNG")


async def test_character_import_invalid_file(client):
    files = {"file": ("junk.txt", b"not a card", "text/plain")}
    resp = await client.post("/api/characters/import", files=files)
    assert resp.status_code == 400


async def test_character_export_json_round_trip(client):
    created = await create_character(client, description="desc", tags=["a"])
    resp = await client.get(f"/api/characters/{created['id']}/export", params={"format": "json"})
    assert resp.status_code == 200
    card = resp.json()
    assert card["spec"] == "chara_card_v2"
    assert card["data"]["name"] == "Serana"


async def test_character_export_png(client):
    created = await create_character(client)
    resp = await client.get(f"/api/characters/{created['id']}/export", params={"format": "png"})
    assert resp.status_code == 200
    assert resp.content.startswith(b"\x89PNG")
    from app.cards.png import read_card_from_png

    card = read_card_from_png(resp.content)
    assert card["data"]["name"] == "Serana"


def _download_names(resp):
    """The two names a Content-Disposition header carries: the plain fallback
    and the decoded UTF-8 one (None when the header has no such parameter)."""
    header = resp.headers["content-disposition"]
    assert header.isascii(), header
    fallback = re.search(r'filename="([^"]*)"', header)
    encoded = re.search(r"filename\*=UTF-8''([^;\s]+)", header)
    assert fallback, header
    return fallback.group(1), unquote(encoded.group(1)) if encoded else None


@pytest.mark.parametrize("format", ["json", "png"])
async def test_export_names_outside_latin1(client, format):
    created = await create_character(client, name="Алиса 紅 ✨")
    resp = await client.get(f"/api/characters/{created['id']}/export", params={"format": format})
    assert resp.status_code == 200
    fallback, real = _download_names(resp)
    assert real == f"Алиса 紅 ✨.{format}"
    # Nothing ASCII is left of this name, so the fallback is a generic one.
    assert fallback == f"card.{format}"


@pytest.mark.parametrize("format", ["json", "png"])
async def test_export_ascii_name_keeps_its_file_name(client, format):
    created = await create_character(client, name="Dr. Vane")
    resp = await client.get(f"/api/characters/{created['id']}/export", params={"format": format})
    assert resp.status_code == 200
    fallback, real = _download_names(resp)
    assert fallback == f"Dr Vane.{format}"
    assert real == f"Dr Vane.{format}"


async def test_export_mixed_name_keeps_its_ascii_letters_in_the_fallback(client):
    created = await create_character(client, name="Vane紅 the Ferryman")
    resp = await client.get(f"/api/characters/{created['id']}/export")
    fallback, real = _download_names(resp)
    assert fallback == "Vane the Ferryman.json"
    assert real == "Vane紅 the Ferryman.json"


@pytest.mark.parametrize("name, fallback", [
    ("Zoë", "Zoe"),
    ("Éloïse", "Eloise"),
    ("Crème Brûlée", "Creme Brulee"),
    ("Ångström", "Angstrom"),
    # Typed with the accent as a separate character, which some keyboards do.
    ("Zoe" + chr(0x0308), "Zoe"),
    # The compatibility forms of NFKD: a ligature and a full-width letter.
    ("ﬁne Ａ", "fine A"),
    ("Zoë 紅", "Zoe"),
])
async def test_export_fallback_folds_accents_instead_of_dropping_letters(client, name, fallback):
    created = await create_character(client, name=name)
    resp = await client.get(f"/api/characters/{created['id']}/export")
    got_fallback, real = _download_names(resp)
    assert got_fallback == f"{fallback}.json"
    # The real name is the card's own, accents included.
    assert real == f"{name}.json"


@pytest.mark.parametrize("name, fallback, real", [
    ("Dr.  Vane", "Dr Vane", "Dr Vane"),
    ("A     B", "A B", "A B"),
    # The space left behind by a letter that has no ASCII form.
    ("Vane 紅 the Ferryman", "Vane the Ferryman", "Vane 紅 the Ferryman"),
])
async def test_export_name_collapses_repeated_spaces(client, name, fallback, real):
    created = await create_character(client, name=name)
    resp = await client.get(f"/api/characters/{created['id']}/export")
    assert _download_names(resp) == (f"{fallback}.json", f"{real}.json")


@pytest.mark.parametrize("name, stem", [
    ("Alice" + chr(0x200D), "Alice"),
    (chr(0x200D) + chr(0x200D) + "Alice" + chr(0x200C), "Alice"),
    ("Alice " + chr(0x200D), "Alice"),
    (chr(0x200D) + " Alice", "Alice"),
])
async def test_export_name_trims_joiners_at_its_ends(client, name, stem):
    # Nothing comes before or after them to be joined to; between letters they
    # stay (see the Persian name below).
    created = await create_character(client, name=name)
    resp = await client.get(f"/api/characters/{created['id']}/export")
    assert _download_names(resp) == (f"{stem}.json", f"{stem}.json")


@pytest.mark.parametrize("name", [
    chr(0x200C), chr(0x200D) + chr(0x200C), " " + chr(0x200D) + " ",
    chr(0x202E), ".", " ",
])
async def test_export_name_with_nothing_to_show_is_called_card(client, name):
    # A joiner is only part of a name when there is something for it to join.
    created = await create_character(client, name=name)
    resp = await client.get(f"/api/characters/{created['id']}/export")
    assert _download_names(resp) == ("card.json", "card.json")


async def test_export_name_drops_invisible_controls_but_keeps_joiners(client):
    bidi_override, zwnj = chr(0x202E), chr(0x200C)
    created = await create_character(client, name=f"{bidi_override}می{zwnj}خواهم")
    resp = await client.get(f"/api/characters/{created['id']}/export")
    _, real = _download_names(resp)
    assert real == f"می{zwnj}خواهم.json"


async def test_export_name_cannot_inject_into_the_header(client):
    created = await create_character(client, name='a"; filename=evil/../x\r\n')
    resp = await client.get(f"/api/characters/{created['id']}/export")
    assert resp.status_code == 200
    fallback, real = _download_names(resp)
    assert fallback == real == "a filenameevilx.json"


async def test_avatar_upload(client):
    created = await create_character(client)
    files = {"file": ("a.png", make_minimal_png(), "image/png")}
    resp = await client.post(f"/api/characters/{created['id']}/avatar", files=files)
    assert resp.status_code == 200
    assert resp.json()["avatar_url"]


# ---------- personas ----------

async def test_persona_crud_and_default(client):
    p1 = (await client.post("/api/personas", json={"name": "Alex"})).json()
    assert p1["is_default"] is True  # first persona becomes default
    p2 = (await client.post("/api/personas", json={"name": "Morgan", "is_default": True})).json()
    assert p2["is_default"] is True
    listed = (await client.get("/api/personas")).json()
    defaults = [p for p in listed if p["is_default"]]
    assert [p["name"] for p in defaults] == ["Morgan"]  # single default enforced
    deleted = await client.delete(f"/api/personas/{p1['id']}")
    assert deleted.status_code == 204


# ---------- connections ----------

async def test_connection_key_masking_and_update(client):
    resp = await client.post("/api/connections", json={
        "name": "OpenRouter",
        "provider": "openai-compatible",
        "base_url": "https://openrouter.ai/api/v1",
        "api_key": "sk-or-v1-secret1234",
        "model": "meta-llama/llama-3-70b",
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert "api_key" not in body
    assert body["api_key_set"] is True
    assert body["api_key_hint"].endswith("1234")
    assert body["is_default"] is True  # first connection becomes default

    # update without api_key keeps the stored key
    upd = (await client.put(f"/api/connections/{body['id']}", json={"name": "OR"})).json()
    assert upd["api_key_set"] is True
    # explicit empty string clears it
    upd = (await client.put(f"/api/connections/{body['id']}", json={"api_key": ""})).json()
    assert upd["api_key_set"] is False


async def test_connection_test_endpoint_unreachable(client):
    created = (await client.post("/api/connections", json={
        "name": "Dead", "provider": "openai-compatible",
        "base_url": "http://127.0.0.1:1", "model": "x",
    })).json()
    resp = await client.post(f"/api/connections/{created['id']}/test")
    assert resp.status_code == 200
    assert resp.json()["ok"] is False


# ---------- conversations ----------

async def test_conversation_created_with_greeting_variants(client):
    char = await create_character(client, alternate_greetings=["Alt greeting"])
    persona = (await client.post("/api/personas", json={"name": "Alex"})).json()
    resp = await client.post("/api/conversations", json={
        "character_id": char["id"], "persona_id": persona["id"],
    })
    assert resp.status_code == 201, resp.text
    convo = resp.json()
    messages = convo["messages"]
    assert len(messages) == 1
    first = messages[0]
    assert first["role"] == "assistant"
    assert first["content"] == "*She stirs.* Hello Alex."  # macros resolved with persona name
    assert len(first["variants"]) == 2  # greeting + alternate


async def test_conversation_list_patch_delete(client):
    char = await create_character(client)
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    listed = (await client.get("/api/conversations")).json()
    assert len(listed) == 1
    assert listed[0]["character"]["name"] == "Serana"

    patched = await client.patch(f"/api/conversations/{convo['id']}", json={"title": "Crypt run"})
    assert patched.json()["title"] == "Crypt run"

    deleted = await client.delete(f"/api/conversations/{convo['id']}")
    assert deleted.status_code == 204
    gone = await client.get(f"/api/conversations/{convo['id']}")
    assert gone.status_code == 404


async def test_conversation_without_greeting_has_no_messages(client):
    char = await create_character(client, greeting="")
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    assert convo["messages"] == []


# ---------- settings ----------

async def test_settings_roundtrip(client):
    initial = (await client.get("/api/settings")).json()
    assert initial["global_instructions"] == ""
    resp = await client.put("/api/settings", json={"global_instructions": "Always in English."})
    assert resp.status_code == 200
    assert (await client.get("/api/settings")).json()["global_instructions"] == "Always in English."


async def test_connection_defaults_are_roleplay_tuned(client):
    """A connection created with no generation params gets RP-friendly defaults."""
    created = (await client.post("/api/connections", json={
        "name": "Bare", "provider": "openai-compatible",
        "base_url": "http://localhost:1234/v1", "model": "x",
    })).json()
    assert created["context_size"] == 16384
    assert created["temperature"] == 0.8
    assert created["max_tokens"] == 1024
    assert created["top_p"] == 0.95


async def test_favorites_toggle_filter_and_sort(client):
    plain = await create_character(client, name="Ordinaire")
    fav = await create_character(client, name="Beloved")
    assert fav["is_favorite"] is False

    updated = (await client.put(f"/api/characters/{fav['id']}", json={"is_favorite": True})).json()
    assert updated["is_favorite"] is True
    assert updated["name"] == "Beloved"  # partial update untouched

    only_favs = (await client.get("/api/characters", params={"favorites": "true"})).json()
    assert [c["id"] for c in only_favs] == [fav["id"]]

    everyone = (await client.get("/api/characters")).json()
    assert everyone[0]["id"] == fav["id"]  # favorites sort first
    assert {c["id"] for c in everyone} == {fav["id"], plain["id"]}


async def test_deleting_default_connection_does_not_break_conversations(client):
    """Regression: a deleted connection left a dangling default in settings,
    then every new conversation failed on the foreign key."""
    conn = (await client.post("/api/connections", json={
        "name": "Jetable", "provider": "openai-compatible",
        "base_url": "http://localhost:1234/v1", "model": "x",
    })).json()
    await client.put("/api/settings", json={"default_connection_id": conn["id"]})
    deleted = await client.delete(f"/api/connections/{conn['id']}")
    assert deleted.status_code == 204

    assert (await client.get("/api/settings")).json()["default_connection_id"] is None

    char = await create_character(client)
    resp = await client.post("/api/conversations", json={"character_id": char["id"]})
    assert resp.status_code == 201, resp.text
    assert resp.json()["connection_id"] is None


async def test_deleting_default_persona_does_not_break_conversations(client):
    persona = (await client.post("/api/personas", json={"name": "Jetable"})).json()
    await client.put("/api/settings", json={"default_persona_id": persona["id"]})
    deleted = await client.delete(f"/api/personas/{persona['id']}")
    assert deleted.status_code == 204

    assert (await client.get("/api/settings")).json()["default_persona_id"] is None

    char = await create_character(client)
    resp = await client.post("/api/conversations", json={"character_id": char["id"]})
    assert resp.status_code == 201, resp.text
