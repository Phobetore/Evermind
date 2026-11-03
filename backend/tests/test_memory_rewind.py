"""What a conversation remembers when its story is cut back: messages removed from a
point on, or a branch made at one.

Memory is tied to the story by positions: a fact says the newest turn that the pass
which drew it had read (``source_position``), the conversation says how far the memory
has read (``memory_position``), and each pass leaves a checkpoint, the summary as it
stood once the turns up to a position were read. Positions are reused once the messages
that held them are gone, so a memory that does not follow the story back is wrong in
three ways: facts born of turns that no longer exist stay canon, the passes that should
come next wait for new turns to pass an old mark, and the summary describes a story that
was never told.

Cutting the story back goes to the newest checkpoint at or before the cut: the summary
is that one's, the memory has read what it had read then, and the next pass reads the
range between, at the usual cost.
"""

import asyncio
import json

import pytest

from app.db import _connect
from app.providers.base import ProviderEvent
from app.repositories import memories as memories_repo
from app.services import memory_service

from .test_chat import FakeProvider, send, setup_conversation
from .test_memory import extract, stored_facts, waiting_provider, within


class Replies:
    """The model that plays the story: a short reply to anything, or what ``text`` says
    when it is asked to summarize. The memory passes talk to the scripted one, so that
    what each is told is not mixed up."""

    text = "Reply."

    def __init__(self, connection):
        self.connection = connection

    async def stream_chat(self, payload):
        yield ProviderEvent(type="delta", text=Replies.text)
        yield ProviderEvent(type="done")


@pytest.fixture()
def fake_provider(monkeypatch):
    Replies.text = "Reply."
    FakeProvider.script = []
    FakeProvider.captured = {}
    monkeypatch.setattr("app.services.chat_service.get_provider", Replies)
    monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
    # A pass that starts by itself after a reply would answer for the test's own.
    monkeypatch.setattr("app.services.memory_service.schedule_if_due", lambda convo_id: None)
    return FakeProvider


async def talk(client, convo_id, exchanges, label="exchange", first=1):
    """Send messages, each answered, with the automatic passes off so that the test
    decides when memory is read."""
    await client.put("/api/settings", json={"auto_memory": False})
    for i in range(exchanges):
        await send(client, convo_id, content=f"{label} {first + i}")


async def messages_of(client, convo_id):
    return (await client.get(f"/api/conversations/{convo_id}")).json()["messages"]


async def at_position(client, convo_id, position):
    return next(m for m in await messages_of(client, convo_id) if m["position"] == position)


async def conversation(client, convo_id):
    return (await client.get(f"/api/conversations/{convo_id}")).json()


async def put_fact(convo_id, content, *, at=0, source="auto", pinned=False):
    db = await _connect()
    try:
        return await memories_repo.add(db, convo_id, content, source_position=at,
                                       is_pinned=pinned, source=source)
    finally:
        await db.close()


async def read_up_to(convo_id, position, summary):
    """As if a pass had read the story up to ``position`` and written ``summary``: what
    the conversation says now, and the checkpoint that a pass leaves."""
    db = await _connect()
    try:
        await db.execute("UPDATE conversations SET memory_position = ?, summary = ?"
                         " WHERE id = ?", (position, summary, convo_id))
        await db.execute("INSERT OR REPLACE INTO memory_checkpoints"
                         " (conversation_id, position, summary, memory_position)"
                         " VALUES (?, ?, ?, ?)", (convo_id, position, summary, position))
        await db.commit()
    finally:
        await db.close()


async def checkpoints_of(convo_id):
    db = await _connect()
    try:
        rows = await (await db.execute(
            "SELECT position, summary, memory_position FROM memory_checkpoints"
            " WHERE conversation_id = ? ORDER BY position", (convo_id,))).fetchall()
        return [tuple(r) for r in rows]
    finally:
        await db.close()


async def remove_from(client, convo_id, position):
    message = await at_position(client, convo_id, position)
    resp = await client.delete(f"/api/messages/{message['id']}?following=true")
    assert resp.status_code == 204, resp.text


async def names(client, convo_id):
    return {m["content"] for m in
            (await client.get(f"/api/conversations/{convo_id}/memories")).json()}


# ---------- removing messages from a point on ----------

async def test_facts_born_of_removed_turns_go_with_them(client, fake_provider):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 4)  # positions 0 (greeting) to 8
    await put_fact(convo["id"], "From an early turn.", at=2)
    await put_fact(convo["id"], "From before any turn.", at=0)
    await put_fact(convo["id"], "From the last turn read.", at=8)
    await put_fact(convo["id"], "From a removed turn, pinned.", at=8, pinned=True)
    await put_fact(convo["id"], "Written by hand.", at=8, source="user")
    await read_up_to(convo["id"], 8, "Everything so far.")

    await remove_from(client, convo["id"], 5)

    assert await names(client, convo["id"]) == {
        "From an early turn.", "From before any turn.",
        "From a removed turn, pinned.", "Written by hand.",
    }


# memory_position before, first position removed, memory_position after, summary kept.
# The memory had one checkpoint, at the position it had read to, so a cut before it has
# nothing to go back to.
REWINDS = [
    (8, 5, 0, False),  # the memory had read turns that are gone, and has no earlier checkpoint
    (5, 5, 0, False),  # and the very first of them
    (4, 5, 4, True),   # it had read up to the turn before, which stays: nothing to undo
    (0, 5, 0, True),   # and it had not read any: the summary is the person's
    (3, 1, 0, False),  # never a negative position
    (0, 1, 0, True),
    (6, 0, 0, False),  # the whole story is gone
    (0, 0, 0, True),   # and a summary nobody's pass wrote is the person's still
]


@pytest.mark.parametrize(("before", "removed_from", "after", "summary_kept"), REWINDS)
async def test_the_memory_goes_back_no_further_than_the_story_does(
        client, fake_provider, before, removed_from, after, summary_kept):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 4)
    if before:
        await read_up_to(convo["id"], before, "Everything so far.")
    else:
        await client.patch(f"/api/conversations/{convo['id']}", json={"summary": "Everything so far."})

    await remove_from(client, convo["id"], removed_from)

    read = await conversation(client, convo["id"])
    assert read["memory_position"] == after
    assert read["summary"] == ("Everything so far." if summary_kept else "")


# A pass at 4 and one at 8, then a cut: the memory goes back to the newest checkpoint at or
# before the cut, with its summary, and the checkpoints after it go.
CHECKPOINTS = [
    (9, 8, "The story to 8.", [4, 8]),  # the cut leaves everything read: nothing moves
    (8, 4, "The story to 4.", [4]),
    (5, 4, "The story to 4.", [4]),
    (4, 0, "", []),                     # before the first checkpoint
]


@pytest.mark.parametrize(("removed_from", "position", "summary", "kept"), CHECKPOINTS)
async def test_a_cut_goes_back_to_the_newest_checkpoint_at_or_before_it(
        client, fake_provider, removed_from, position, summary, kept):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 5)  # positions 0 to 10
    await read_up_to(convo["id"], 4, "The story to 4.")
    await read_up_to(convo["id"], 8, "The story to 8.")

    await remove_from(client, convo["id"], removed_from)

    read = await conversation(client, convo["id"])
    assert (read["memory_position"], read["summary"]) == (position, summary)
    assert [c[0] for c in await checkpoints_of(convo["id"])] == kept


async def test_removing_from_the_first_message_removes_every_fact_it_can(client, fake_provider):
    """A fact drawn from "before any turn" is older than every turn only while some turn
    is left. With none, nothing it was drawn from remains."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    await put_fact(convo["id"], "From before any turn.", at=0)
    await put_fact(convo["id"], "From the first turn.", at=1)
    await put_fact(convo["id"], "Pinned.", at=0, pinned=True)
    await put_fact(convo["id"], "Written by hand.", at=0, source="user")
    await read_up_to(convo["id"], 4, "Everything so far.")

    await remove_from(client, convo["id"], 0)

    assert await messages_of(client, convo["id"]) == []
    assert await names(client, convo["id"]) == {"Pinned.", "Written by hand."}
    assert await checkpoints_of(convo["id"]) == []
    read = await conversation(client, convo["id"])
    assert (read["memory_position"], read["summary"]) == (0, "")


async def test_removing_one_message_leaves_the_memory_alone(client, fake_provider):
    """Only a cut touches the memory. A hole in the story is not a cut, and nothing
    says what the fact drawn from it was."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 3)
    await put_fact(convo["id"], "From a late turn.", at=6)
    await read_up_to(convo["id"], 6, "Everything so far.")
    message = await at_position(client, convo["id"], 3)

    resp = await client.delete(f"/api/messages/{message['id']}")

    assert resp.status_code == 204
    read = await conversation(client, convo["id"])
    assert (read["memory_position"], read["summary"]) == (6, "Everything so far.")
    assert await names(client, convo["id"]) == {"From a late turn."}
    assert await checkpoints_of(convo["id"]) == [(6, "Everything so far.", 6)]


async def test_the_next_pass_reads_the_turns_that_came_after_a_removal(client, fake_provider):
    """Eight replies, the memory read twice, the story taken back, new replies. The memory
    goes back to what it had read at the first pass, with that summary, at once and
    whether or not automatic passes are on. The next pass reads the turns between, which
    survive and are read again, and the new ones, and nothing else; what it learned from
    the survivors comes back, and what it learned from the turns that are gone does not."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 4, label="old exchange")  # positions 0 to 8
    await put_fact(convo_id, "Kept by hand.", source="user")
    first = await extract(client, convo_id, {
        "facts": [{"content": "Learned early.", "kind": "event"}],
        "summary": "The first four exchanges."})
    assert [f["source_position"] for f in first["facts_added"]] == [8]
    await talk(client, convo_id, 4, label="old exchange", first=5)  # positions 9 to 16
    await extract(client, convo_id, {
        "facts": [{"content": "Learned from turn 9.", "kind": "event"},
                  {"content": "Learned in removed turns.", "kind": "event"}],
        "summary": "Eight exchanges."})
    assert (await conversation(client, convo_id))["memory_position"] == 16

    await remove_from(client, convo_id, 11)

    rewound = await conversation(client, convo_id)
    assert (rewound["memory_position"], rewound["summary"]) == (8, "The first four exchanges.")
    assert await names(client, convo_id) == {"Kept by hand.", "Learned early."}
    assert await checkpoints_of(convo_id) == [(8, "The first four exchanges.", 8)]

    await talk(client, convo_id, memory_service.MAINTENANCE_EVERY, label="new exchange")  # 11 to 22
    db = await _connect()
    try:
        assert await memory_service._new_assistant_count(
            db, await conversation(client, convo_id)) >= memory_service.MAINTENANCE_EVERY
        await client.put("/api/settings", json={"auto_memory": True})
        assert await memory_service.is_due(db, convo_id)
    finally:
        await db.close()

    fake_provider.captured.clear()
    await extract(client, convo_id, {
        "facts": [{"content": "Learned from turn 9.", "kind": "event"},
                  {"content": "Learned afterwards.", "kind": "event"}],
        "summary": "Then something else."})

    shown = fake_provider.captured["payload"].messages[0]["content"]
    assert "CURRENT SUMMARY:\nThe first four exchanges." in shown
    assert "- Learned early." in shown
    assert "Learned in removed turns." not in shown
    assert "(turn 9): old exchange 5" in shown
    assert "(turn 11): new exchange 1" in shown
    assert "(turn 8)" not in shown
    assert "old exchange 6" not in shown
    final = await stored_facts(client, convo_id)
    assert [(f[0], f[2]) for f in final] == [
        ("Kept by hand.", 0), ("Learned afterwards.", 22), ("Learned early.", 8),
        ("Learned from turn 9.", 22)]
    assert (await conversation(client, convo_id))["memory_position"] == 22
    assert [c[0] for c in await checkpoints_of(convo_id)] == [8, 22]


async def test_a_long_story_cut_back_gets_its_summary_back_and_not_a_rebuilt_one(
        client, fake_provider):
    """A pass reads at most 40 turns. After 500 turns and a cut in the middle, forgetting
    the summary would leave a new one to be written from the last 40 turns before the
    cut, the story to that point reduced to them. The checkpoint at 240 has all of it."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    db = await _connect()
    try:
        await db.executemany(
            "INSERT INTO messages (id, conversation_id, role, variants, active_index,"
            " position, meta, created_at) VALUES (?, ?, ?, ?, 0, ?, '{}', '2026-01-01T00:00:00Z')",
            [(f"m{n:04d}", convo_id, "user" if n % 2 else "assistant",
              json.dumps([f"Turn number {n}."]), n) for n in range(1, 501)])
        await db.executemany(
            "INSERT INTO memory_checkpoints (conversation_id, position, summary, memory_position)"
            " VALUES (?, ?, ?, ?)",
            [(convo_id, n, f"Summary to {n}.", n) for n in range(40, 481, 40)])
        await db.execute("UPDATE conversations SET memory_position = 480,"
                         " summary = 'Summary to 480.' WHERE id = ?", (convo_id,))
        await db.commit()
    finally:
        await db.close()

    await remove_from(client, convo_id, 250)

    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (240, "Summary to 240.")
    assert [c[0] for c in await checkpoints_of(convo_id)] == list(range(40, 241, 40))
    fake_provider.captured.clear()
    await extract(client, convo_id, {"facts": [], "summary": "Summary to 249."})
    shown = fake_provider.captured["payload"].messages[0]["content"]
    assert "CURRENT SUMMARY:\nSummary to 240." in shown
    assert "(turn 241): Turn number 241." in shown
    assert "(turn 249): Turn number 249." in shown
    assert "(turn 240)" not in shown and "(turn 250)" not in shown


async def test_a_summary_a_person_typed_stays_when_the_story_is_cut_back(client, fake_provider):
    """The box is theirs to edit. A summary that is not the one the last pass wrote is not
    something to take back to an older one, as a fact they wrote is not."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 4)
    await read_up_to(convo["id"], 4, "The story to 4.")
    await read_up_to(convo["id"], 8, "The story to 8.")
    await client.patch(f"/api/conversations/{convo['id']}", json={"summary": "In my own words."})

    await remove_from(client, convo["id"], 7)

    read = await conversation(client, convo["id"])
    assert (read["memory_position"], read["summary"]) == (4, "In my own words.")
    assert [c[0] for c in await checkpoints_of(convo["id"])] == [4]


async def test_a_summary_that_only_differs_by_its_edges_is_the_one_the_pass_wrote(
        client, fake_provider):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 4)
    await read_up_to(convo["id"], 4, "The story to 4.")
    await read_up_to(convo["id"], 8, "The story to 8.")
    await client.patch(f"/api/conversations/{convo['id']}", json={"summary": "  The story to 8.\n"})

    await remove_from(client, convo["id"], 7)

    assert (await conversation(client, convo["id"]))["summary"] == "The story to 4."


async def test_a_summary_asked_for_is_a_place_to_go_back_to(client, fake_provider):
    """Generating a summary reads turns without drawing facts from them, so the memory
    goes back to where it had read, with the summary that was written."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 2)  # positions 0 to 4
    await extract(client, convo_id, {"facts": [], "summary": "Written by a pass."})
    await talk(client, convo_id, 2, first=3)  # 5 to 8
    Replies.text = "Written when asked for."
    resp = await client.post(f"/api/conversations/{convo_id}/summarize")
    assert resp.status_code == 200, resp.text
    assert await checkpoints_of(convo_id) == [
        (4, "Written by a pass.", 4), (8, "Written when asked for.", 4)]
    await talk(client, convo_id, 2, first=5)  # 9 to 12
    await extract(client, convo_id, {"facts": [], "summary": "Written by a later pass."})

    await remove_from(client, convo_id, 11)

    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (4, "Written when asked for.")
    assert [c[0] for c in await checkpoints_of(convo_id)] == [4, 8]


async def test_a_summary_asked_for_that_covers_removed_turns_goes_back_too(client, fake_provider):
    """The memory had read less than the summary describes: a cut between the two still
    makes the summary false."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 2)
    await extract(client, convo_id, {"facts": [], "summary": "Written by a pass."})
    await talk(client, convo_id, 2, first=3)
    Replies.text = "Written when asked for."
    await client.post(f"/api/conversations/{convo_id}/summarize")

    await remove_from(client, convo_id, 6)

    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (4, "Written by a pass.")
    assert await checkpoints_of(convo_id) == [(4, "Written by a pass.", 4)]


async def test_a_branch_after_a_removal_takes_what_the_removal_left(client, fake_provider):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 4, label="old exchange")
    await extract(client, convo_id, {"facts": [{"content": "Learned early.", "kind": "event"}],
                                     "summary": "The first four."})
    await talk(client, convo_id, 4, label="old exchange", first=5)
    await extract(client, convo_id, {"facts": [{"content": "Learned later.", "kind": "event"}],
                                     "summary": "All eight."})
    await remove_from(client, convo_id, 11)
    await talk(client, convo_id, 1, label="new exchange")  # positions 11 and 12

    here = await at_position(client, convo_id, 10)
    branch = (await client.post(f"/api/messages/{here['id']}/branch")).json()
    assert (branch["memory_position"], branch["summary"]) == (8, "The first four.")
    assert await names(client, branch["id"]) == {"Learned early."}
    assert await checkpoints_of(branch["id"]) == [(8, "The first four.", 8)]

    earlier = await at_position(client, convo_id, 6)
    shorter = (await client.post(f"/api/messages/{earlier['id']}/branch")).json()
    assert (shorter["memory_position"], shorter["summary"]) == (0, "")
    assert await names(client, shorter["id"]) == set()
    assert await checkpoints_of(shorter["id"]) == []
    # The conversation it was made from is as the removal left it.
    assert (await conversation(client, convo_id))["memory_position"] == 8


async def test_a_pass_that_was_reading_when_the_story_was_cut_leaves_nothing_of_it(
        client, fake_provider, monkeypatch):
    """The model answers about turns that are no longer there. What it learned from
    them is not canon, and the memory is not read up to a point the story no longer
    reaches, where new turns would then be taken for old ones."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 3)  # positions 0 to 6
    started, release, asked = waiting_provider(monkeypatch)
    FakeProvider.script = [ProviderEvent(type="delta", text=json.dumps({
        "facts": [{"content": "Learned from turns that went.", "kind": "event"}],
        "summary": "A story that was cut."})), ProviderEvent(type="done")]

    reading = asyncio.create_task(client.post(f"/api/conversations/{convo['id']}/memories/extract"))
    try:
        await within(5, started.wait())
        await remove_from(client, convo["id"], 3)
    finally:
        release.set()
    answered = await within(5, reading)

    assert answered.status_code == 200, answered.text
    assert answered.json()["skipped"] == "changed"
    assert answered.json()["facts_added"] == []
    assert await names(client, convo["id"]) == set()
    read = await conversation(client, convo["id"])
    assert (read["memory_position"], read["summary"]) == (0, "")
    assert await checkpoints_of(convo["id"]) == []

    # The next pass starts from where the story is.
    await send(client, convo["id"], content="After the cut")
    asked.clear()
    again = await extract(client, convo["id"], {
        "facts": [{"content": "Learned after the cut.", "kind": "event"}]})
    assert [f["source_position"] for f in again["facts_added"]] == [4]
    assert "(turn 3): After the cut" in asked[0].messages[0]["content"]


async def test_a_pass_that_was_reading_is_kept_when_only_later_turns_were_added(
        client, fake_provider, monkeypatch):
    """Turns sent while the model reads are not a change to the ones it read."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)  # positions 0 to 4
    started, release, _ = waiting_provider(monkeypatch)
    FakeProvider.script = [ProviderEvent(type="delta", text=json.dumps({
        "facts": [{"content": "Learned meanwhile.", "kind": "event"}]})),
        ProviderEvent(type="done")]

    reading = asyncio.create_task(client.post(f"/api/conversations/{convo['id']}/memories/extract"))
    try:
        await within(5, started.wait())
        await send(client, convo["id"], content="Sent during the pass")
    finally:
        release.set()
    answered = await within(5, reading)

    assert "skipped" not in answered.json()
    assert [f["content"] for f in answered.json()["facts_added"]] == ["Learned meanwhile."]
    assert (await conversation(client, convo["id"]))["memory_position"] == 4


# ---------- a branch is a cut too ----------

async def test_a_branch_keeps_the_facts_of_turns_up_to_its_message_and_what_a_person_made_theirs(
        client, fake_provider):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 4)
    await put_fact(convo["id"], "From before any turn.", at=0)
    await put_fact(convo["id"], "From the fork.", at=4)
    await put_fact(convo["id"], "From after the fork.", at=5)
    await put_fact(convo["id"], "Pinned, from after the fork.", at=8, pinned=True)
    await put_fact(convo["id"], "Written by hand.", at=0, source="user")
    await read_up_to(convo["id"], 8, "Everything so far.")
    fork = await at_position(client, convo["id"], 4)

    branch = (await client.post(f"/api/messages/{fork['id']}/branch")).json()

    assert await names(client, branch["id"]) == {
        "From before any turn.", "From the fork.", "Written by hand.",
        "Pinned, from after the fork."}


@pytest.mark.parametrize(("before", "fork", "after", "summary_kept"), [
    (8, 4, 0, False),  # the memory had read past the fork, and has no earlier checkpoint
    (5, 4, 0, False),
    (4, 4, 4, True),   # it had read up to it: the summary describes the branch
    (2, 4, 2, True),
    (6, 0, 0, False),
])
async def test_a_branch_reads_the_memory_up_to_its_message(
        client, fake_provider, before, fork, after, summary_kept):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 4)
    await read_up_to(convo["id"], before, "Everything so far.")
    message = await at_position(client, convo["id"], fork)

    branch = (await client.post(f"/api/messages/{message['id']}/branch")).json()

    assert branch["memory_position"] == after
    assert branch["summary"] == ("Everything so far." if summary_kept else "")
    assert [c[0] for c in await checkpoints_of(branch["id"])] == ([before] if summary_kept else [])


# ---------- a cut during a pass ----------

async def test_a_cut_after_the_pass_wrote_goes_back_through_what_it_left(client, fake_provider):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 3)
    await extract(client, convo_id, {"facts": [{"content": "Learned.", "kind": "event"}],
                                     "summary": "The three."})
    assert await checkpoints_of(convo_id) == [(6, "The three.", 6)]

    await remove_from(client, convo_id, 5)

    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (0, "")
    assert await names(client, convo_id) == set()
    assert await checkpoints_of(convo_id) == []
