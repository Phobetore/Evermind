"""The checkpoints that passes leave, and the migration that gives them to the
conversations that already exist.

A checkpoint is the running summary as it stood when the memory had read the turns up to
a position, and how far the facts had been read then. Cutting the story back goes to the
newest one at or before the cut (see test_memory_rewind.py), so what writes them, and
what does not, decides what a cut can restore.
"""

import sqlite3
from pathlib import Path

import pytest

from app.db import _connect
from app.providers.base import ProviderEvent

from .test_chat import FakeProvider, send, setup_conversation
from .test_memory import extract

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


class Replies:
    text = "Reply."

    def __init__(self, connection):
        self.connection = connection

    async def stream_chat(self, payload):
        yield ProviderEvent(type="delta", text=Replies.text)
        yield ProviderEvent(type="done")


@pytest.fixture()
def models(monkeypatch):
    Replies.text = "Reply."
    FakeProvider.script = []
    FakeProvider.captured = {}
    monkeypatch.setattr("app.services.chat_service.get_provider", Replies)
    monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
    monkeypatch.setattr("app.services.memory_service.schedule_if_due", lambda convo_id: None)


async def checkpoints_of(convo_id):
    db = await _connect()
    try:
        rows = await (await db.execute(
            "SELECT position, summary, memory_position FROM memory_checkpoints"
            " WHERE conversation_id = ? ORDER BY position", (convo_id,))).fetchall()
        return [tuple(r) for r in rows]
    finally:
        await db.close()


async def talk(client, convo_id, exchanges, first=1):
    for i in range(exchanges):
        await send(client, convo_id, content=f"exchange {first + i}")


# ---------- what writes one ----------

async def test_a_pass_leaves_a_checkpoint_at_the_turn_it_read_to(client, models):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)  # positions 0 to 4

    await extract(client, convo["id"], {"facts": [], "summary": "The first two."})

    assert await checkpoints_of(convo["id"]) == [(4, "The first two.", 4)]


async def test_a_later_pass_adds_one_and_a_pass_at_the_same_place_replaces_it(client, models):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    await extract(client, convo["id"], {"facts": [], "summary": "The first two."})
    await talk(client, convo["id"], 1, first=3)  # positions 5 and 6
    await extract(client, convo["id"], {"facts": [], "summary": "The first three."})

    assert await checkpoints_of(convo["id"]) == [
        (4, "The first two.", 4), (6, "The first three.", 6)]

    db = await _connect()
    try:
        await db.execute("UPDATE conversations SET memory_position = 4 WHERE id = ?",
                         (convo["id"],))
        await db.commit()
    finally:
        await db.close()
    await extract(client, convo["id"], {"facts": [], "summary": "Said again."})

    assert await checkpoints_of(convo["id"]) == [
        (4, "The first two.", 4), (6, "Said again.", 6)]


async def test_a_pass_that_gives_no_summary_checkpoints_the_one_the_conversation_has(
        client, models):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    await extract(client, convo["id"], {"facts": [], "summary": "The first two."})
    await talk(client, convo["id"], 1, first=3)

    await extract(client, convo["id"], {"facts": []})

    assert await checkpoints_of(convo["id"]) == [
        (4, "The first two.", 4), (6, "The first two.", 6)]


async def test_a_pass_that_is_refused_leaves_no_checkpoint(client, models):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    FakeProvider.script = [ProviderEvent(type="delta", text="not json"), ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")

    assert resp.status_code == 502
    assert await checkpoints_of(convo["id"]) == []


async def test_a_pass_with_nothing_new_to_read_leaves_no_checkpoint(client, models):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    await extract(client, convo["id"], {"facts": [], "summary": "The first two."})

    await extract(client, convo["id"], {"facts": [], "summary": "Said again."})

    assert await checkpoints_of(convo["id"]) == [(4, "The first two.", 4)]


async def test_a_summary_asked_for_leaves_one_at_the_last_message_without_moving_the_memory(
        client, models):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    await extract(client, convo["id"], {"facts": [], "summary": "The first two."})
    await talk(client, convo["id"], 1, first=3)
    Replies.text = "Written when asked for."

    resp = await client.post(f"/api/conversations/{convo['id']}/summarize")

    assert resp.status_code == 200, resp.text
    assert resp.json()["summary"] == "Written when asked for."
    assert resp.json()["memory_position"] == 4
    assert await checkpoints_of(convo["id"]) == [
        (4, "The first two.", 4), (6, "Written when asked for.", 4)]


async def test_a_summary_asked_for_of_a_conversation_the_memory_never_read(client, models):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 1)
    Replies.text = "Written when asked for."

    await client.post(f"/api/conversations/{convo['id']}/summarize")

    assert await checkpoints_of(convo["id"]) == [(2, "Written when asked for.", 0)]


async def test_deleting_a_conversation_deletes_its_checkpoints(client, models):
    convo = await setup_conversation(client)
    other = await setup_conversation(client)
    for each in (convo, other):
        await talk(client, each["id"], 1)
        await extract(client, each["id"], {"facts": [], "summary": "Something."})

    resp = await client.delete(f"/api/conversations/{convo['id']}")

    assert resp.status_code == 204
    assert await checkpoints_of(convo["id"]) == []
    assert len(await checkpoints_of(other["id"])) == 1


# ---------- what the migration gives the conversations that exist ----------

def database_before_the_checkpoints(path):
    """A database as the version before this one left it."""
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")
    for file in sorted(MIGRATIONS.glob("*.sql")):
        if file.name < "011":
            conn.executescript(file.read_text(encoding="utf-8"))
    return conn


def story(conn, convo_id, last_position, *, memory_position, summary):
    conn.execute("INSERT INTO characters (id, name, created_at, updated_at)"
                 " VALUES (?, 'X', 'then', 'then')", (f"char-{convo_id}",))
    conn.execute(
        "INSERT INTO conversations (id, character_id, title, summary, memory_position,"
        " created_at, updated_at) VALUES (?, ?, '', ?, ?, 'then', 'then')",
        (convo_id, f"char-{convo_id}", summary, memory_position))
    for position in range(last_position + 1):
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, variants, active_index,"
            " position, meta, created_at) VALUES (?, ?, 'user', '[\"x\"]', 0, ?, '{}', 'then')",
            (f"{convo_id}-{position}", convo_id, position))


def apply_011(conn):
    for file in sorted(MIGRATIONS.glob("011_*.sql")):
        conn.executescript(file.read_text(encoding="utf-8"))
    conn.commit()


def state(conn, convo_id):
    row = conn.execute("SELECT memory_position, summary FROM conversations WHERE id = ?",
                       (convo_id,)).fetchone()
    checkpoints = conn.execute(
        "SELECT position, summary, memory_position FROM memory_checkpoints"
        " WHERE conversation_id = ? ORDER BY position", (convo_id,)).fetchall()
    return tuple(row), [tuple(c) for c in checkpoints]


def test_a_conversation_the_memory_has_read_gets_a_checkpoint_from_its_summary(tmp_path):
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "read", 10, memory_position=8, summary="Up to eight.")

    apply_011(conn)

    assert state(conn, "read") == ((8, "Up to eight."), [(8, "Up to eight.", 8)])


def test_a_conversation_the_memory_never_read_gets_none_and_keeps_its_summary(tmp_path):
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "unread", 10, memory_position=0, summary="Typed by hand.")

    apply_011(conn)

    assert state(conn, "unread") == ((0, "Typed by hand."), [])


def test_a_conversation_stalled_past_its_last_message_is_brought_back_to_it(tmp_path):
    """Messages removed from a point on left the position where it was, and new turns
    then waited to pass it. It cannot be later than the last turn."""
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "stalled", 4, memory_position=16, summary="Up to sixteen, it said.")
    story(conn, "empty", 0, memory_position=12, summary="Of a story no longer there.")
    conn.execute("DELETE FROM messages WHERE conversation_id = 'empty'")

    apply_011(conn)

    assert state(conn, "stalled") == (
        (4, "Up to sixteen, it said."), [(4, "Up to sixteen, it said.", 4)])
    assert state(conn, "empty") == ((0, "Of a story no longer there."), [])


def test_a_conversation_that_is_fine_is_not_touched_but_for_its_checkpoint(tmp_path):
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "fine", 10, memory_position=10, summary="Up to ten.")

    apply_011(conn)

    assert state(conn, "fine") == ((10, "Up to ten."), [(10, "Up to ten.", 10)])


def test_deleting_a_conversation_with_the_migration_applied_deletes_its_checkpoints(tmp_path):
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "read", 10, memory_position=8, summary="Up to eight.")
    apply_011(conn)

    conn.execute("DELETE FROM conversations WHERE id = 'read'")

    assert conn.execute("SELECT COUNT(*) FROM memory_checkpoints").fetchone()[0] == 0


async def test_a_conversation_from_before_the_checkpoints_can_be_cut_back(client, models):
    """What the migration seeds is what a cut goes back to: a conversation whose memory
    had read to 8 keeps its summary through a cut after that, and loses it, with the
    facts it gave, through one before."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 5)  # positions 0 to 10
    db = await _connect()
    try:
        await db.execute("DELETE FROM memory_checkpoints")
        await db.execute("UPDATE conversations SET memory_position = 8, summary = 'Up to eight.'"
                         " WHERE id = ?", (convo["id"],))
        # What the migration does, on the rows that are there.
        await db.execute(
            "INSERT INTO memory_checkpoints (conversation_id, position, summary, memory_position)"
            " SELECT id, memory_position, summary, memory_position FROM conversations"
            " WHERE memory_position > 0")
        await db.commit()
    finally:
        await db.close()
    last = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    after_the_read = next(m for m in last if m["position"] == 9)
    before_the_read = next(m for m in last if m["position"] == 5)

    await client.delete(f"/api/messages/{after_the_read['id']}?following=true")
    kept = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert (kept["memory_position"], kept["summary"]) == (8, "Up to eight.")

    await client.delete(f"/api/messages/{before_the_read['id']}?following=true")
    gone = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert (gone["memory_position"], gone["summary"]) == (0, "")

