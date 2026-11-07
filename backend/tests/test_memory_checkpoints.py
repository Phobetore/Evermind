"""The checkpoints that passes leave, and the migration that gives them to the
conversations that already exist.

A checkpoint is the summary the memory had written when it had read the turns up to a
position, how far the facts had been read then, and a copy of the facts the model had
written. Cutting the story back goes to the newest one at or before the cut (see
test_memory_rewind.py), so what writes them, and what does not, decides what a cut can
restore.
"""

import sqlite3
from pathlib import Path

import pytest

from app.db import _connect
from app.providers.base import ProviderEvent
from app.repositories.base import dumps

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


async def copies_of(convo_id, position):
    db = await _connect()
    try:
        rows = await (await db.execute(
            "SELECT fact_id, kind, content, source_position FROM memory_checkpoint_facts"
            " WHERE conversation_id = ? AND position = ?", (convo_id, position))).fetchall()
        return {tuple(r) for r in rows}
    finally:
        await db.close()


async def talk(client, convo_id, exchanges, first=1):
    for i in range(exchanges):
        await send(client, convo_id, content=f"exchange {first + i}")


async def remove_from(client, convo_id, position):
    messages = (await client.get(f"/api/conversations/{convo_id}")).json()["messages"]
    message = next(m for m in messages if m["position"] == position)
    resp = await client.delete(f"/api/messages/{message['id']}?following=true")
    assert resp.status_code == 204, resp.text


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


async def test_a_pass_that_gives_no_summary_checkpoints_the_one_before(client, models):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    await extract(client, convo["id"], {"facts": [], "summary": "The first two."})
    await talk(client, convo["id"], 1, first=3)

    await extract(client, convo["id"], {"facts": []})

    assert await checkpoints_of(convo["id"]) == [
        (4, "The first two.", 4), (6, "The first two.", 6)]


async def test_a_pass_that_gives_no_summary_does_not_make_a_typed_one_look_like_its_own(
        client, models):
    """It would be the newest checkpoint's, which is what says a summary is the model's,
    and the next cut would take away what the person wrote."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    await extract(client, convo["id"], {"facts": [], "summary": "The first two."})
    await client.patch(f"/api/conversations/{convo['id']}", json={"summary": "In my own words."})
    await talk(client, convo["id"], 1, first=3)

    await extract(client, convo["id"], {"facts": []})

    assert await checkpoints_of(convo["id"]) == [
        (4, "The first two.", 4), (6, "The first two.", 6)]
    await remove_from(client, convo["id"], 5)
    read = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert (read["memory_position"], read["summary"]) == (4, "In my own words.")


async def test_a_first_pass_that_gives_no_summary_does_not_make_a_typed_one_look_like_its_own(
        client, models):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    await client.patch(f"/api/conversations/{convo['id']}", json={"summary": "In my own words."})

    await extract(client, convo["id"], {"facts": []})

    assert await checkpoints_of(convo["id"]) == [(4, "", 4)]
    await remove_from(client, convo["id"], 3)
    assert (await client.get(f"/api/conversations/{convo['id']}")).json()["summary"] == "In my own words."


async def test_a_checkpoint_copies_every_fact_the_model_wrote_and_none_a_person_wrote(client, models):
    """Pinned or not: one pinned now may not be when the story is cut back."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    await client.post(f"/api/conversations/{convo['id']}/memories", json={"content": "By hand."})
    await extract(client, convo["id"], {"facts": [{"content": "Plain.", "kind": "event"},
                                                  {"content": "To pin.", "kind": "state"}]})
    facts = {f["content"]: f for f in
             (await client.get(f"/api/conversations/{convo['id']}/memories")).json()}
    await client.patch(f"/api/memories/{facts['To pin.']['id']}", json={"is_pinned": True})
    await talk(client, convo["id"], 1, first=3)
    await extract(client, convo["id"], {"facts": []})

    assert await copies_of(convo["id"], 6) == {
        (facts["Plain."]["id"], "event", "Plain.", 4),
        (facts["To pin."]["id"], "state", "To pin.", 4)}


async def test_a_summary_asked_for_copies_the_facts_too(client, models):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    await extract(client, convo["id"], {"facts": [{"content": "Plain.", "kind": "event"}]})
    await talk(client, convo["id"], 1, first=3)
    Replies.text = "Written when asked for."

    await client.post(f"/api/conversations/{convo['id']}/summarize")

    assert {row[2] for row in await copies_of(convo["id"], 6)} == {"Plain."}


async def test_a_pass_at_the_same_place_replaces_the_copy(client, models):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    await extract(client, convo["id"], {"facts": [{"content": "Then.", "kind": "fact"}]})
    Replies.text = "Asked for."
    facts = (await client.get(f"/api/conversations/{convo['id']}/memories")).json()
    await client.patch(f"/api/memories/{facts[0]['id']}", json={"content": "Now."})
    await client.post(f"/api/conversations/{convo['id']}/memories",
                      json={"content": "Not the model's."})

    await client.post(f"/api/conversations/{convo['id']}/summarize")

    assert {row[2] for row in await copies_of(convo["id"], 4)} == {"Now."}


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
        await extract(client, each["id"], {"facts": [{"content": "Learned.", "kind": "fact"}],
                                           "summary": "Something."})

    resp = await client.delete(f"/api/conversations/{convo['id']}")

    assert resp.status_code == 204
    assert await checkpoints_of(convo["id"]) == []
    assert await copies_of(convo["id"], 2) == set()
    assert len(await checkpoints_of(other["id"])) == 1
    assert len(await copies_of(other["id"], 2)) == 1


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


def fact(conn, convo_id, name, position, *, pinned=0, source="auto"):
    conn.execute(
        "INSERT INTO memories (id, conversation_id, kind, content, source_position, is_pinned,"
        " source, created_at) VALUES (?, ?, 'fact', ?, ?, ?, ?, 'then')",
        (name, convo_id, f"The fact {name}.", position, pinned, source))


def facts_of(conn, convo_id):
    return [tuple(r) for r in conn.execute(
        "SELECT id, source_position FROM memories WHERE conversation_id = ? ORDER BY id",
        (convo_id,))]


def copies(conn):
    return [tuple(r) for r in conn.execute(
        "SELECT conversation_id, position, fact_id, source_position FROM memory_checkpoint_facts"
        " ORDER BY 1, 2, 3")]


def down_to_its_greeting(conn, convo_id):
    """Its first message is a greeting, marked as the application marks one."""
    conn.execute("UPDATE messages SET meta = ? WHERE conversation_id = ? AND position = 0",
                 (dumps({"greeting": True}), convo_id))


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

    apply_011(conn)

    # Nothing says how much of it is true, and it is all there is of the turns before.
    assert state(conn, "stalled") == (
        (4, "Up to sixteen, it said."), [(4, "Up to sixteen, it said.", 4)])


def test_a_conversation_with_no_message_left_remembers_nothing_of_it(tmp_path):
    """The memory had read a story that is gone. What the model wrote of it goes, and
    what a person wrote or pinned stays, at the start."""
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "empty", 0, memory_position=12, summary="Of a story no longer there.")
    conn.execute("DELETE FROM messages WHERE conversation_id = 'empty'")
    fact(conn, "empty", "model", 12)
    fact(conn, "empty", "pinned", 12, pinned=1)
    fact(conn, "empty", "hand", 0, source="user")

    apply_011(conn)

    assert state(conn, "empty") == ((0, ""), [])
    assert facts_of(conn, "empty") == [("hand", 0), ("pinned", 0)]
    assert copies(conn) == []


def test_a_story_deleted_back_to_its_greeting_remembers_nothing_of_it(tmp_path):
    """The ordinary shape of a story that is gone. A greeting is the card's, and nothing the
    memory held was drawn from it."""
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "greeted", 0, memory_position=12, summary="Of a story no longer there.")
    down_to_its_greeting(conn, "greeted")
    fact(conn, "greeted", "model", 12)
    fact(conn, "greeted", "pinned", 12, pinned=1)
    fact(conn, "greeted", "hand", 0, source="user")

    apply_011(conn)

    assert state(conn, "greeted") == ((0, ""), [])
    assert facts_of(conn, "greeted") == [("hand", 0), ("pinned", 0)]
    assert copies(conn) == []


def test_a_greeting_and_no_memory_leave_a_summary_that_may_be_someones_own(tmp_path):
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "greeted", 0, memory_position=0, summary="Before anything was said.")
    down_to_its_greeting(conn, "greeted")

    apply_011(conn)

    assert state(conn, "greeted") == ((0, "Before anything was said."), [])


def test_a_first_message_that_is_no_greeting_is_a_story_still(tmp_path):
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "first", 0, memory_position=12, summary="Up to twelve, it said.")
    fact(conn, "first", "model", 12)

    apply_011(conn)

    assert state(conn, "first") == ((0, "Up to twelve, it said."), [])
    assert facts_of(conn, "first") == [("model", 0)]


def test_a_greeting_with_turns_after_it_is_a_story_still(tmp_path):
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "greeted", 4, memory_position=2, summary="Up to two.")
    down_to_its_greeting(conn, "greeted")
    fact(conn, "greeted", "model", 2)

    apply_011(conn)

    assert state(conn, "greeted") == ((2, "Up to two."), [(2, "Up to two.", 2)])
    assert facts_of(conn, "greeted") == [("model", 2)]


def test_a_summary_with_no_message_and_no_memory_may_be_someones_own(tmp_path):
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "new", 0, memory_position=0, summary="Before anything was said.")
    conn.execute("DELETE FROM messages WHERE conversation_id = 'new'")

    apply_011(conn)

    assert state(conn, "new") == ((0, "Before anything was said."), [])


def test_the_first_checkpoint_holds_the_facts_of_the_model(tmp_path):
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "read", 10, memory_position=8, summary="Up to eight.")
    fact(conn, "read", "plain", 8)
    fact(conn, "read", "pinned", 4, pinned=1)
    fact(conn, "read", "hand", 0, source="user")
    story(conn, "never", 4, memory_position=0, summary="")
    fact(conn, "never", "unread", 0)

    apply_011(conn)

    assert copies(conn) == [("read", 8, "pinned", 4), ("read", 8, "plain", 8)]


def test_facts_from_past_the_end_of_a_stalled_story_come_back_to_it(tmp_path):
    """Nothing says which of them are true, so they stay; but the prompt must not place
    one at a turn that does not exist, and a checkpoint must not hold one past itself."""
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "stalled", 4, memory_position=16, summary="Up to sixteen, it said.")
    fact(conn, "stalled", "before", 2)
    fact(conn, "stalled", "past", 16)
    fact(conn, "stalled", "pinned", 16, pinned=1)

    apply_011(conn)

    assert facts_of(conn, "stalled") == [("before", 2), ("past", 4), ("pinned", 4)]
    assert copies(conn) == [("stalled", 4, "before", 2), ("stalled", 4, "past", 4),
                            ("stalled", 4, "pinned", 4)]


def test_a_conversation_that_is_fine_is_not_touched_but_for_its_checkpoint(tmp_path):
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "fine", 10, memory_position=10, summary="Up to ten.")

    apply_011(conn)

    assert state(conn, "fine") == ((10, "Up to ten."), [(10, "Up to ten.", 10)])


def test_deleting_a_conversation_with_the_migration_applied_deletes_its_checkpoints(tmp_path):
    conn = database_before_the_checkpoints(tmp_path / "old.db")
    story(conn, "read", 10, memory_position=8, summary="Up to eight.")
    apply_011(conn)

    fact(conn, "read", "plain", 8)
    conn.execute("INSERT INTO memory_checkpoint_facts SELECT conversation_id, 8, id, kind,"
                 " content, source_position FROM memories")

    conn.execute("DELETE FROM conversations WHERE id = 'read'")

    assert conn.execute("SELECT COUNT(*) FROM memory_checkpoints").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM memory_checkpoint_facts").fetchone()[0] == 0


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
        await db.execute("INSERT INTO memories (id, conversation_id, kind, content,"
                         " source_position, source, created_at)"
                         " VALUES ('f', ?, 'fact', 'Read by then.', 8, 'auto', 'then')",
                         (convo["id"],))
        # What the migration does, on the rows that are there.
        await db.execute(
            "INSERT INTO memory_checkpoints (conversation_id, position, summary, memory_position)"
            " SELECT id, memory_position, summary, memory_position FROM conversations"
            " WHERE memory_position > 0")
        await db.execute(
            "INSERT INTO memory_checkpoint_facts SELECT c.id, c.memory_position, f.id, f.kind,"
            " f.content, f.source_position FROM conversations c JOIN memories f"
            " ON f.conversation_id = c.id WHERE c.memory_position > 0")
        await db.commit()
    finally:
        await db.close()
    last = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    after_the_read = next(m for m in last if m["position"] == 9)
    before_the_read = next(m for m in last if m["position"] == 5)

    await client.delete(f"/api/messages/{after_the_read['id']}?following=true")
    kept = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert (kept["memory_position"], kept["summary"]) == (8, "Up to eight.")
    facts = (await client.get(f"/api/conversations/{convo['id']}/memories")).json()
    assert [f["content"] for f in facts] == ["Read by then."]

    await client.delete(f"/api/messages/{before_the_read['id']}?following=true")
    gone = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert (gone["memory_position"], gone["summary"]) == (0, "")
    assert (await client.get(f"/api/conversations/{convo['id']}/memories")).json() == []

