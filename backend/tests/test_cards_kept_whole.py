"""The card a character was read from, kept whole beside it, and the lorebook settings it carries."""

import sqlite3
from pathlib import Path

import pytest

from app import db
from app.config import db_path

MIGRATIONS = Path(db.MIGRATIONS_DIR)

# Twelve of the 13 settings away from their default, so that none can be lost unnoticed;
# each entry gives its own `origin`, the 13th.
SETTINGS = {
    "comment": "The harbour",
    "constant": True,
    "selective": True,
    "secondary_keys": ["dock", "pier"],
    "selective_logic": 2,
    "insertion_order": -7,
    "position": 4,
    "depth": 9,
    "role": "assistant",
    "whole_words": False,
    "exclude_recursion": True,
    "prevent_recursion": True,
}


def rows(sql, params=()):
    conn = sqlite3.connect(db_path())
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def card(text="{}", **overrides) -> dict:
    return {"text": text, "format": "json", "read": {"name": "Serana"}, **overrides}


async def make(client, **fields) -> dict:
    resp = await client.post("/api/characters", json={"name": "Serana", **fields})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_a_card_keeps_the_file_it_was_read_from_apart_from_its_fields(client):
    text = '{"spec": "chara_card_v3", "data": "' + "x" * 300_000 + '"}'
    made = await make(client, card={
        "text": text, "format": "png", "other_text": '{"name": "Serana"}',
        "read": {"name": "Serana", "description": "A vampire."}})

    kept = (await client.get(f"/api/characters/{made['id']}/card")).json()
    assert kept["text"] == text
    assert kept["format"] == "png"
    assert kept["other_text"] == '{"name": "Serana"}'
    assert kept["read"]["description"] == "A vampire."
    assert kept["read_at"]

    character = (await client.get(f"/api/characters/{made['id']}")).json()
    assert character["has_card"] is True
    assert "text" not in character
    assert "read" not in character


async def test_the_reading_kept_with_the_card_is_what_the_server_stored(client):
    made = await make(client, card=card(read={"name": "Serana", "card": card(), "lore_entries": [
        {"keys": ["a"], "content": "", "origin": 0},
        {"keys": [], "content": "No keyword, not always on.", "origin": 1},
        {"keys": ["b"], "content": "\x1c", "origin": 2},
        {"keys": [" k "], "content": "The bell rings.", "origin": 3},
        {"keys": [], "content": "Always there.", "constant": True, "origin": 4},
    ]}))

    read = (await client.get(f"/api/characters/{made['id']}/card")).json()["read"]
    assert "card" not in read
    assert [(e["keys"], e["content"], e["origin"]) for e in read["lore_entries"]] == [
        (["k"], "The bell rings.", 3),
        ([], "Always there.", 4),
    ]


async def test_a_card_made_here_has_no_card_file(client):
    made = await make(client)

    assert (await client.get(f"/api/characters/{made['id']}/card")).json() is None
    assert made["has_card"] is False
    assert (await client.get(f"/api/characters/{made['id']}")).json()["has_card"] is False
    missing = await client.get("/api/characters/unknown/card")
    assert missing.status_code == 404
    assert missing.json()["kind"] == "not_found"


async def test_the_list_of_cards_carries_no_card_file(client):
    await make(client, card=card(text='"' + "x" * 2_000_000 + '"'))
    await make(client, name="Lydia")

    listed = (await client.get("/api/characters")).json()
    assert len(listed) == 2
    for row in listed:
        assert "has_card" in row
        assert all(len(str(value)) <= 10_000 for value in row.values())


async def test_saving_the_lorebook_keeps_each_entry_s_origin_and_settings(client):
    made = await make(client)
    entries = [
        {"keys": ["harbour"], "content": "Ships.", "enabled": False, "origin": 5, **SETTINGS},
        {"keys": ["bell"], "content": "It rings.", "enabled": True, "origin": 1,
         **SETTINGS, "position": 0, "role": "user", "depth": 0},
        {"keys": ["tower"], "content": "Tall.", "enabled": True, "origin": 0,
         **SETTINGS, "selective_logic": 3, "insertion_order": 2**53 - 1, "position": 7},
    ]
    resp = await client.put(f"/api/characters/{made['id']}", json={"lore_entries": entries})
    assert resp.status_code == 200, resp.text

    stored = (await client.get(f"/api/characters/{made['id']}")).json()["lore_entries"]
    assert [{name: e[name] for name in entries[0]} for e in stored] == entries


async def test_secondary_keys_are_cleaned_as_keys_are(client):
    made = await make(client)
    entry = {"keys": ["sea"], "content": "Waves.", "secondary_keys": [" night ", ""], "origin": 0}
    resp = await client.put(f"/api/characters/{made['id']}", json={
        "lore_entries": [entry], "card": card(read={"name": "Serana", "lore_entries": [entry]})})
    assert resp.status_code == 200, resp.text

    stored = (await client.get(f"/api/characters/{made['id']}")).json()["lore_entries"]
    assert [e["secondary_keys"] for e in stored] == [["night"]]
    read = (await client.get(f"/api/characters/{made['id']}/card")).json()["read"]
    assert [e["secondary_keys"] for e in read["lore_entries"]] == [["night"]]


async def test_a_card_file_is_at_least_the_shortest_json_object(client):
    for text in ("", "{"):
        resp = await client.post("/api/characters", json={"name": "Serana", "card": card(text=text)})
        assert resp.status_code == 422, text
    await make(client, card=card(text="{}"))


async def test_an_always_on_entry_needs_no_keyword_but_every_entry_needs_text(client):
    made = await make(client, lore_entries=[
        {"keys": [], "constant": True, "content": "x"},
        {"keys": [], "content": "x"},
        {"keys": ["k"], "constant": True, "content": " "},
    ])

    stored = (await client.get(f"/api/characters/{made['id']}")).json()["lore_entries"]
    assert [(e["keys"], e["constant"], e["content"]) for e in stored] == [([], True, "x")]


async def test_two_entries_cannot_claim_the_same_entry_of_the_card(client):
    twice = [{"keys": ["a"], "content": "A", "origin": 3}, {"keys": ["b"], "content": "B", "origin": 3}]
    refused = await client.post("/api/characters", json={"name": "Serana", "lore_entries": twice})
    assert refused.status_code == 422

    made = await make(client)
    refused = await client.put(f"/api/characters/{made['id']}", json={"lore_entries": twice})
    assert refused.status_code == 422

    neither = [{**entry, "origin": None} for entry in twice]
    accepted = await client.put(f"/api/characters/{made['id']}", json={"lore_entries": neither})
    assert accepted.status_code == 200, accepted.text


async def test_a_nickname_is_bounded_as_the_name_is(client):
    # In code points, as the interface counts when it cuts a card's name or nickname.
    longest = "é" * 199 + "\U0001f30a"
    made = await make(client, name=longest, nickname=longest)
    assert (made["name"], made["nickname"]) == (longest, longest)

    for field in ("name", "nickname"):
        refused = await client.post("/api/characters", json={"name": "Serana", field: longest + "x"})
        assert refused.status_code == 422, field
        refused = await client.put(f"/api/characters/{made['id']}", json={field: longest + "x"})
        assert refused.status_code == 422, field


async def test_a_card_from_a_page_that_predates_the_rules_keeps_the_old_ones(client):
    assert (await make(client))["card_rules"] == 1
    assert (await make(client, card_rules=2))["card_rules"] == 2


async def test_replacing_the_card_file_keeps_one(client):
    made = await make(client)
    url = f"/api/characters/{made['id']}"

    for text in ('{"first": 1}', '{"second": 2}'):
        resp = await client.put(url, json={"card": card(text=text)})
        assert resp.status_code == 200, resp.text

    assert rows("SELECT text FROM character_cards WHERE character_id = ?", (made["id"],)) == [
        ('{"second": 2}',)]
    assert (await client.get(f"{url}/card")).json()["text"] == '{"second": 2}'


async def test_deleting_a_character_deletes_its_card_file(client):
    made = await make(client, card=card())
    assert rows("SELECT COUNT(*) FROM character_cards") == [(1,)]

    assert (await client.delete(f"/api/characters/{made['id']}")).status_code == 204

    assert rows("SELECT COUNT(*) FROM character_cards") == [(0,)]


async def test_a_save_that_sends_back_what_it_read_changes_nothing(client):
    made = await make(
        client, card_rules=2, nickname="Sera", character_note="Stay in the crypt.",
        character_note_depth=0, character_note_role="user",
        creator_notes_multilingual={"fr": "Une vampire."},
        lore_entries=[
            {"keys": ["harbour"], "content": "Ships.", "origin": 2, **SETTINGS},
            {"keys": ["bell"], "content": "It rings.", "enabled": False},
        ],
        card=card(read={"name": "Serana", "lore_entries": [
            {"keys": ["harbour"], "content": "Ships.", "origin": 2}]}))
    url = f"/api/characters/{made['id']}"
    before = (await client.get(url)).json()
    card_before = (await client.get(f"{url}/card")).json()

    resp = await client.put(url, json=before)
    assert resp.status_code == 200, resp.text

    after = (await client.get(url)).json()

    def unchanged(character):
        entries = [{k: v for k, v in e.items() if k not in ("id", "created_at", "updated_at")}
                   for e in character["lore_entries"]]
        rest = {k: v for k, v in character.items() if k not in ("updated_at", "lore_entries")}
        return rest, entries

    assert unchanged(after) == unchanged(before)
    assert after["lore_entries"][0]["origin"] == 2
    assert (await client.get(f"{url}/card")).json() == card_before


@pytest.fixture()
def start(tmp_path, monkeypatch):
    """Adds migration files and starts the application again, on the same database."""
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", tmp_path)

    async def start(files):
        for name, sql in files.items():
            (tmp_path / name).write_text(sql, encoding="utf-8")
        await db.init_db()

    return start


def migrations(numbers) -> dict[str, str]:
    return {path.name: path.read_text(encoding="utf-8")
            for path in sorted(MIGRATIONS.glob("*.sql")) if int(path.name[:3]) in numbers}


async def test_the_update_keeps_old_cards_on_the_old_rules_and_their_entries_in_their_order(start):
    await start(migrations(range(1, 19)))
    conn = sqlite3.connect(db_path())
    try:
        for char_id in ("serana", "lydia"):
            conn.execute("INSERT INTO characters (id, name, created_at, updated_at)"
                         " VALUES (?, ?, 't', 't')", (char_id, char_id))
        # Inserted out of their order: the oldest last, and two that share their second.
        # Those two sort the other way by id, so only insertion breaks their tie, as today.
        for entry_id, char_id, created_at in (
                ("late", "serana", "2026-01-01T00:00:02+00:00"),
                ("lydia-only", "lydia", "2026-01-01T00:00:00+00:00"),
                ("zz-first", "serana", "2026-01-01T00:00:01+00:00"),
                ("aa-second", "serana", "2026-01-01T00:00:01+00:00")):
            conn.execute("INSERT INTO lore_entries (id, character_id, keys, content, enabled,"
                         " created_at, updated_at) VALUES (?, ?, '[\"k\"]', 'c', 1, ?, ?)",
                         (entry_id, char_id, created_at, created_at))
        conn.commit()
    finally:
        conn.close()

    await start(migrations({19}))

    assert rows("SELECT id, card_rules, nickname, character_note, character_note_depth,"
                " character_note_role, creator_notes_multilingual FROM characters ORDER BY id") == [
        ("lydia", 1, "", "", 4, "system", "{}"),
        ("serana", 1, "", "", 4, "system", "{}"),
    ]
    assert rows("SELECT id, insertion_order FROM lore_entries WHERE character_id = 'serana'"
                " ORDER BY created_at, rowid") == [("zz-first", 0), ("aa-second", 1), ("late", 2)]
    assert rows("SELECT insertion_order FROM lore_entries WHERE character_id = 'lydia'") == [(0,)]
    assert rows("SELECT DISTINCT origin, comment, constant, selective, secondary_keys,"
                " selective_logic, position, depth, role, whole_words, exclude_recursion,"
                " prevent_recursion, keys, content, enabled FROM lore_entries") == [
        (None, "", 0, 0, "[]", 0, 1, 4, "system", 1, 0, 0, '["k"]', "c", 1)]
    assert rows("SELECT COUNT(*) FROM lore_entries") == [(4,)]
    assert rows("SELECT COUNT(*) FROM character_cards") == [(0,)]
