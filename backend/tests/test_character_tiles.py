"""The light list of the home page, and the search of descriptions that went with the long fields:
what a tile carries, the excerpt it is given and when that is worked out again."""

import asyncio
import gzip
import json
import sqlite3
from pathlib import Path

from app.config import db_path
from app.services import card_text

CASES = json.loads((Path(__file__).parent / "cases" / "card_excerpt.json").read_text(encoding="utf-8"))["cases"]
TILE_KEYS = {"id", "kind", "name", "nickname", "tagline", "tags", "excerpt", "avatar_url",
             "avatar_thumb_url", "is_favorite", "card_rules", "created_at", "updated_at"}


async def tiles(client) -> list[dict]:
    resp = await client.get("/api/characters", params={"fields": "card"})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def make(client, **fields) -> dict:
    resp = await client.post("/api/characters", json={"name": "Serana", **fields})
    assert resp.status_code == 201, resp.text
    return resp.json()


def column(char_id, name):
    conn = sqlite3.connect(db_path())
    try:
        return conn.execute(f"SELECT {name} FROM characters WHERE id = ?", (char_id,)).fetchone()[0]
    finally:
        conn.close()


async def test_a_tile_carries_no_long_field(client):
    for i in range(300):
        await make(client, name=f"Card {i}", description="d" * 20_000,
                   alternate_greetings=["a" * 5_000, "b" * 5_000], tags=["one", "two"])
    out = await tiles(client)
    assert len(out) == 300
    for tile in out:
        assert set(tile) == TILE_KEYS
        rest = {k: v for k, v in tile.items() if k not in ("name", "tagline", "tags", "excerpt")}
        assert len(json.dumps(rest)) < 400


async def test_the_light_list_of_three_hundred_cards_stays_light(client):
    for i in range(300):
        await make(client, name=f"Card {i}", tagline="A tagline of ordinary length",
                   description=("Elle garde le gué depuis trois hivers. " * 130)[:5_000],
                   tags=["fantasy", "elf", "river", "quiet", "guard", "old", "female", "slow-burn"])
    body = (await client.get("/api/characters", params={"fields": "card"})).content
    assert len(gzip.compress(body, 9)) < 52_000


async def test_a_tile_has_its_excerpt(client):
    sample = next(c for c in CASES if c["name"].startswith("the card of the mock-up"))
    char = await make(client, tagline="Gardienne du gué", **sample["input"])
    (tile,) = await tiles(client)
    assert tile["id"] == char["id"]
    assert tile["excerpt"] == sample["expected"]
    assert tile["tagline"] == "Gardienne du gué"
    assert tile["avatar_url"] is None and tile["avatar_thumb_url"] is None


async def test_the_excerpt_follows_the_description(client):
    char = await make(client, description="Elle garde le gué depuis trois hivers et plus encore.")
    (first,) = await tiles(client)
    resp = await client.put(f"/api/characters/{char['id']}",
                            json={"description": "Il veille sur la tour grise depuis des années."})
    assert resp.status_code == 200
    (second,) = await tiles(client)
    assert second["excerpt"] == "Il veille sur la tour grise depuis des années."
    (third,) = await tiles(client)
    # Working an excerpt out is no edit: the card keeps its place.
    assert third["updated_at"] == second["updated_at"]
    assert first["excerpt"] != second["excerpt"]


async def test_a_new_rule_works_every_excerpt_out_again(client, monkeypatch):
    for i in range(3):
        await make(client, name=f"Card {i}", description="Elle garde le gué depuis trois hivers.")
    assert all(not t["excerpt"].startswith("nouvelle") for t in await tiles(client))
    monkeypatch.setattr(card_text, "EXCERPT_RULE", card_text.EXCERPT_RULE + 1)
    monkeypatch.setattr(card_text, "card_excerpt", lambda description, name: "nouvelle règle " + name)
    out = await tiles(client)
    assert sorted(t["excerpt"] for t in out) == [f"nouvelle règle Card {i}" for i in range(3)]


async def test_search_takes_the_words_as_one_piece(client):
    yes = await make(client, name="Une", description="C'est une elfe brume-née du nord.")
    await make(client, name="Deux", description="Une brume épaisse, puis plus loin une elfe.")
    resp = await client.get("/api/characters/search", params={"q": "elfe brume"})
    assert resp.json() == [yes["id"]]


async def test_tiles_keep_the_order_of_the_list(client):
    first = await make(client, name="First")
    second = await make(client, name="Second")
    await client.put(f"/api/characters/{first['id']}", json={"is_favorite": True})
    ids = [t["id"] for t in await tiles(client)]
    assert ids == [first["id"], second["id"]]
    assert ids == [c["id"] for c in (await client.get("/api/characters")).json()]


async def test_an_edit_during_a_list_is_not_overwritten(client, monkeypatch):
    char = await make(client, description="Une description d'avant, longue de quelques mots.")
    original = card_text.card_excerpt
    calls = []

    def edited_meanwhile(description, name):
        if not calls:
            # What a PUT writes, in the same second as the read: updated_at stays as it was.
            conn = sqlite3.connect(db_path())
            try:
                conn.execute("UPDATE characters SET description = ?, excerpt = NULL WHERE id = ?",
                             ("brumelune, une toute nouvelle description pour la fiche.", char["id"]))
                conn.commit()
            finally:
                conn.close()
        calls.append(name)
        return "ancien extrait"

    monkeypatch.setattr(card_text, "card_excerpt", edited_meanwhile)
    (tile,) = await tiles(client)
    assert tile["excerpt"] == "ancien extrait"
    assert column(char["id"], "excerpt") is None
    monkeypatch.setattr(card_text, "card_excerpt", original)
    (tile,) = await tiles(client)
    assert tile["excerpt"] == "brumelune, une toute nouvelle description pour la fiche."


async def test_excerpts_are_worked_out_off_the_event_loop(client, monkeypatch):
    for i in range(3):
        await make(client, name=f"Card {i}", description="Elle garde le gué depuis trois hivers.")
    original = card_text.card_excerpt
    off_loop = []

    def noting(description, name):
        try:
            asyncio.get_running_loop()
            off_loop.append(False)
        except RuntimeError:
            off_loop.append(True)
        return original(description, name)

    monkeypatch.setattr(card_text, "card_excerpt", noting)
    await tiles(client)
    assert off_loop == [True, True, True]


async def test_search_finds_a_word_of_the_description(client):
    char = await make(client, description="Elle suit la brumelune chaque nuit.")
    await make(client, name="Other", description="Rien à voir.")
    assert (await client.get("/api/characters/search", params={"q": "brumelune"})).json() == [char["id"]]
    assert (await client.get("/api/characters/search", params={"q": "BRUMELUNE"})).json() == [char["id"]]
    assert (await client.get("/api/characters/search", params={"q": ""})).json() == []


async def test_search_reads_the_name_and_the_tagline(client):
    by_name = await make(client, name="Zéphyrine")
    by_tagline = await make(client, name="Other", tagline="La voix de Zéphyrine")
    found = (await client.get("/api/characters/search", params={"q": "zéphyrine"})).json()
    assert sorted(found) == sorted([by_name["id"], by_tagline["id"]])


async def test_an_unknown_fields_value_is_refused(client):
    resp = await client.get("/api/characters", params={"fields": "all"})
    assert resp.status_code == 422
