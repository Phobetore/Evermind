"""What a conversation remembers when its story is cut back: messages removed from a
point on, or a branch made at one.

Memory is tied to the story by positions: a fact says the newest turn that the pass
which drew it had read (``source_position``), the conversation says how far the memory
has read (``memory_position``), and each pass leaves a checkpoint, what the memory held
once the turns up to a position were read: the summary and a copy of the model's facts.
Positions are reused once the messages that held them are gone, so a memory that does not
follow the story back is wrong in three ways: facts born of turns that no longer exist
stay canon, the passes that should come next wait for new turns to pass an old mark, and
the summary describes a story that was never told.

Cutting the story back goes to the newest checkpoint at or before the cut: the summary and
the model's facts are that one's, the memory has read what it had read then, and the next
pass reads the range between, at the usual cost.
"""

import asyncio
import json

import pytest

from app.db import _connect
from app.providers.base import ProviderEvent
from app.repositories import conversations as convo_repo
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
        await convo_repo.checkpoint(db, convo_id, position, summary)
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


@pytest.mark.parametrize("automatic", [False, True])
async def test_the_summary_is_back_at_once_whether_or_not_automatic_passes_are_on(
        client, fake_provider, automatic):
    """Nothing waits for a pass: the checkpoint is there to be gone back to, and the
    story's summary is true as soon as the story is cut."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 4)
    await read_up_to(convo["id"], 4, "The story to 4.")
    await read_up_to(convo["id"], 8, "The story to 8.")
    await client.put("/api/settings", json={"auto_memory": automatic})
    fake_provider.captured.clear()

    await remove_from(client, convo["id"], 7)

    read = await conversation(client, convo["id"])
    assert (read["memory_position"], read["summary"]) == (4, "The story to 4.")
    assert fake_provider.captured == {}, "a model was asked, where the summary was just read back"


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


async def test_removing_one_message_goes_through_the_same_cut(client, fake_provider):
    """The memory read the turns after it with it in the story, and nothing says what they
    drew from it. It goes back to before it, and the next pass reads again the ones that
    stay. The interface does not do this, but the API lets anyone."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await told_then_corrected(client, convo_id)
    message = await at_position(client, convo_id, 11)

    resp = await client.delete(f"/api/messages/{message['id']}")

    assert resp.status_code == 204
    assert [m["position"] for m in await messages_of(client, convo_id)] == [
        n for n in range(17) if n != 11]
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (8, "To 8.")
    assert await stored_facts(client, convo_id) == [("Alice is alive.", "state", 8, False, "auto")]
    assert await checkpoints_of(convo_id) == [(8, "To 8.", 8)]

    fake_provider.captured.clear()
    await extract(client, convo_id, {"facts": [], "summary": "Again."})
    shown = fake_provider.captured["payload"].messages[0]["content"]
    assert "(turn 9)" in shown and "(turn 10)" in shown and "(turn 12)" in shown and "(turn 16)" in shown
    assert "(turn 11)" not in shown and "(turn 8)" not in shown
    assert (await conversation(client, convo_id))["memory_position"] == 16


async def test_removing_the_last_message_alone_is_a_cut_before_it(client, fake_provider):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 2)
    await extract(client, convo_id, {"facts": [{"content": "Learned.", "kind": "fact"}],
                                     "summary": "To 4."})
    message = await at_position(client, convo_id, 4)

    assert (await client.delete(f"/api/messages/{message['id']}")).status_code == 204

    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (0, "")
    assert await names(client, convo_id) == set()


async def test_a_pass_that_was_reading_when_one_message_went_keeps_nothing(
        client, fake_provider, monkeypatch):
    """The newest turn it read is still there: it is what it read that changed."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 3)
    started, release, _ = waiting_provider(monkeypatch)
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps({
        "facts": [{"content": "Learned from a turn that went.", "kind": "event"}],
        "summary": "With it."})), ProviderEvent(type="done")]
    message = await at_position(client, convo_id, 3)

    reading = asyncio.create_task(client.post(f"/api/conversations/{convo_id}/memories/extract"))
    try:
        await within(5, started.wait())
        await client.delete(f"/api/messages/{message['id']}")
    finally:
        release.set()
    answered = await within(5, reading)

    assert answered.json()["skipped"] == "changed"
    assert await names(client, convo_id) == set()
    assert (await conversation(client, convo_id))["memory_position"] == 0


# ---------- the first message of a story ----------

async def test_a_first_message_that_is_no_greeting_is_read(client, fake_provider):
    """With no greeting, the story starts at position 0, and what it says is the story."""
    convo = await setup_conversation(client, greeting="")
    convo_id = convo["id"]
    await talk(client, convo_id, 1, label="first words")  # positions 0 and 1
    fake_provider.captured.clear()

    await extract(client, convo_id, {"facts": [{"content": "Learned.", "kind": "fact"}]})

    shown = fake_provider.captured["payload"].messages[0]["content"]
    assert "(turn 0): first words 1" in shown
    assert "(turn 1)" in shown


async def test_a_greeting_is_not_read(client, fake_provider):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 1)
    fake_provider.captured.clear()

    await extract(client, convo["id"], {"facts": []})

    shown = fake_provider.captured["payload"].messages[0]["content"]
    assert "(turn 0)" not in shown
    assert "(turn 1)" in shown


async def test_the_first_message_of_a_story_cut_from_the_start_is_read(client, fake_provider):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 2)
    await remove_from(client, convo_id, 0)
    await talk(client, convo_id, 1, label="a new start")
    fake_provider.captured.clear()

    await extract(client, convo_id, {"facts": []})

    assert "(turn 0): a new start 1" in fake_provider.captured["payload"].messages[0]["content"]


async def test_a_pass_that_read_only_the_first_message_has_read_nothing_as_far_as_a_position_says(
        client, fake_provider, monkeypatch):
    """Position 0 still means nothing was read, so the next pass reads it again, and what
    it says again is not recorded twice."""
    class Stops:
        def __init__(self, connection):
            pass

        async def stream_chat(self, payload):
            yield ProviderEvent(type="error", message="Down.", meta={"kind": "model_error"})

    monkeypatch.setattr("app.services.chat_service.get_provider", Stops)
    convo = await setup_conversation(client, greeting="")
    convo_id = convo["id"]
    await send(client, convo_id, content="Only this.")
    assert [m["position"] for m in await messages_of(client, convo_id)] == [0]

    first = await extract(client, convo_id, {"facts": [{"content": "Learned.", "kind": "fact"}],
                                             "summary": "Just this."})
    assert [f["source_position"] for f in first["facts_added"]] == [0]
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (0, "Just this.")
    assert await checkpoints_of(convo_id) == [(0, "Just this.", 0)]

    fake_provider.captured.clear()
    again = await extract(client, convo_id, {"facts": [{"content": "Learned.", "kind": "fact"}]})
    assert "(turn 0): Only this." in fake_provider.captured["payload"].messages[0]["content"]
    assert again["facts_added"] == []
    assert await names(client, convo_id) == {"Learned."}


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
    """What a person pinned from after the fork stays with the conversation it came from,
    which keeps it: the branch is a story in which that never happened."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 4)
    await put_fact(convo["id"], "From before any turn.", at=0)
    await put_fact(convo["id"], "From the fork.", at=4)
    await put_fact(convo["id"], "From after the fork.", at=5)
    await put_fact(convo["id"], "Pinned, from the fork.", at=4, pinned=True)
    await put_fact(convo["id"], "Pinned, from after the fork.", at=8, pinned=True)
    await put_fact(convo["id"], "Written by hand.", at=0, source="user")
    await read_up_to(convo["id"], 8, "Everything so far.")
    fork = await at_position(client, convo["id"], 4)
    source = await stored_facts(client, convo["id"])

    branch = (await client.post(f"/api/messages/{fork['id']}/branch")).json()

    assert await names(client, branch["id"]) == {
        "From before any turn.", "From the fork.", "Written by hand.", "Pinned, from the fork."}
    assert await stored_facts(client, convo["id"]) == source


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


# ---------- a cut while a pass works out its vectors, or after it wrote ----------

async def test_a_cut_while_the_pass_works_out_its_vectors_leaves_none_of_what_it_learned(
        client, fake_provider, monkeypatch):
    """The model has answered and the vectors of what it learned take a while, when the
    story is cut back. The facts are drawn from turns that are gone, and the position the
    pass was about to set is past the end of the story."""
    from app.prompting import embeddings

    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 3)  # positions 0 to 6
    in_the_vectors, go_on = asyncio.Event(), asyncio.Event()

    async def embed(texts, kind):
        in_the_vectors.set()
        await go_on.wait()

    monkeypatch.setattr(embeddings, "embed", embed)
    FakeProvider.script = [ProviderEvent(type="delta", text=json.dumps({
        "facts": [{"content": "First learned.", "kind": "event"},
                  {"content": "Second learned.", "kind": "event"}],
        "summary": "A story that was cut."})), ProviderEvent(type="done")]

    reading = asyncio.create_task(client.post(f"/api/conversations/{convo_id}/memories/extract"))
    try:
        await within(5, in_the_vectors.wait())
        await remove_from(client, convo_id, 3)
    finally:
        go_on.set()
    answered = await within(5, reading)

    assert answered.status_code == 200, answered.text
    assert answered.json()["skipped"] == "changed"
    assert await names(client, convo_id) == set()
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (0, "")
    assert await checkpoints_of(convo_id) == []
    # And what comes next is read from where the story is.
    await talk(client, convo_id, memory_service.MAINTENANCE_EVERY, label="after")
    db = await _connect()
    try:
        assert await memory_service._new_assistant_count(
            db, await conversation(client, convo_id)) >= memory_service.MAINTENANCE_EVERY
    finally:
        await db.close()


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


# ---------- what a checkpoint keeps of the facts ----------

async def copy_at(convo_id, position):
    """The copy of the facts that the checkpoint at ``position`` holds, by text."""
    db = await _connect()
    try:
        rows = await (await db.execute(
            "SELECT content FROM memory_checkpoint_facts WHERE conversation_id = ?"
            " AND position = ?", (convo_id, position))).fetchall()
        return {r["content"] for r in rows}
    finally:
        await db.close()


async def fact_named(client, convo_id, content):
    facts = (await client.get(f"/api/conversations/{convo_id}/memories")).json()
    return next(f for f in facts if f["content"] == content)


async def told_then_corrected(client, convo_id):
    """Talk to 8, a pass adds a fact; talk to 16, a pass corrects it."""
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [{"content": "Alice is alive.", "kind": "state"}],
                                     "summary": "To 8."})
    await talk(client, convo_id, 4, first=5)
    await extract(client, convo_id, {
        "updated_facts": [{"replaces": "Alice is alive.", "content": "Alice died on the bridge."}],
        "summary": "To 16."})


async def test_a_fact_a_later_pass_corrected_is_back_as_it_was(client, fake_provider):
    convo = await setup_conversation(client)
    await told_then_corrected(client, convo["id"])
    corrected = await fact_named(client, convo["id"], "Alice died on the bridge.")

    await remove_from(client, convo["id"], 11)

    assert await stored_facts(client, convo["id"]) == [("Alice is alive.", "state", 8, False, "auto")]
    # The same fact, so that what a person does to it reaches the copies that name it.
    assert (await fact_named(client, convo["id"], "Alice is alive."))["id"] == corrected["id"]
    read = await conversation(client, convo["id"])
    assert (read["memory_position"], read["summary"]) == (8, "To 8.")


async def test_a_fact_a_later_pass_dropped_is_back(client, fake_provider):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [{"content": "Alice is alive.", "kind": "state"}]})
    dropped = await fact_named(client, convo_id, "Alice is alive.")
    await talk(client, convo_id, 4, first=5)
    await extract(client, convo_id, {"obsolete_facts": ["Alice is alive."]})
    assert await names(client, convo_id) == set()

    await remove_from(client, convo_id, 11)

    assert await stored_facts(client, convo_id) == [("Alice is alive.", "state", 8, False, "auto")]
    assert (await fact_named(client, convo_id, "Alice is alive."))["id"] == dropped["id"]


async def test_a_movable_fact_the_copy_does_not_hold_goes(client, fake_provider):
    convo = await setup_conversation(client)
    await told_then_corrected(client, convo["id"])
    # Its position says nothing against it: only the copy says what memory held then.
    await put_fact(convo["id"], "Written since, at an old position.", at=2)

    await remove_from(client, convo["id"], 11)

    assert await names(client, convo["id"]) == {"Alice is alive."}


async def test_nothing_is_restored_when_the_memory_had_not_read_past_the_cut(client, fake_provider):
    """What a consolidation merged was merged from what is still read: a cut after it takes
    nothing the facts were drawn from, so it undoes nothing."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [{"content": "One.", "kind": "fact"}]})
    await talk(client, convo_id, 2, first=5)
    await put_fact(convo_id, "Merged since.", at=8)
    one = await fact_named(client, convo_id, "One.")
    await client.delete(f"/api/memories/{one['id']}")

    await remove_from(client, convo_id, 11)

    assert await names(client, convo_id) == {"Merged since."}
    assert (await conversation(client, convo_id))["memory_position"] == 8


async def test_a_consolidation_is_undone_only_by_a_cut_before_it(client, fake_provider):
    """It leaves the copies as they are, and the next pass copies what it merged."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [{"content": f"Fact {n}.", "kind": "fact"}
                                               for n in range(8)]})
    before = await copy_at(convo_id, 8)
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps(
        {"facts": [{"content": "All merged."}]})), ProviderEvent(type="done")]
    assert (await client.post(f"/api/conversations/{convo_id}/memories/consolidate")).status_code == 200
    assert await copy_at(convo_id, 8) == before
    await talk(client, convo_id, 4, first=5)
    await extract(client, convo_id, {"facts": [{"content": "Later.", "kind": "fact"}]})
    assert await copy_at(convo_id, 16) == {"All merged.", "Later."}

    await remove_from(client, convo_id, 11)

    assert await names(client, convo_id) == before


async def test_a_restored_fact_never_has_the_vector_of_another_text(
        client, fake_provider, monkeypatch):
    from app.prompting import embeddings

    convo = await setup_conversation(client)
    convo_id = convo["id"]

    async def embed(texts, kind):
        return [[float(len(text)), 1.0] for text in texts]

    monkeypatch.setattr(embeddings, "embed", embed)
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [{"content": "Stays as it is.", "kind": "fact"},
                                               {"content": "To be corrected.", "kind": "fact"},
                                               {"content": "To be dropped.", "kind": "fact"}]})
    await talk(client, convo_id, 4, first=5)
    await extract(client, convo_id, {
        "updated_facts": [{"replaces": "To be corrected.", "content": "Corrected, much longer."}],
        "obsolete_facts": ["To be dropped."]})

    await remove_from(client, convo_id, 11)

    async def vectors():
        db = await _connect()
        try:
            rows = await (await db.execute("SELECT content, embedding FROM memories")).fetchall()
            return {r["content"]: r["embedding"] for r in rows}
        finally:
            await db.close()

    held = await vectors()
    assert set(held) == {"Stays as it is.", "To be corrected.", "To be dropped."}
    assert held["Stays as it is."] == embeddings.pack([float(len("Stays as it is.")), 1.0])
    assert held["To be corrected."] is None
    assert held["To be dropped."] is None
    # The backfill fills what has none, with the vector of the text it holds.
    db = await _connect()
    try:
        assert await memory_service.backfill_embeddings(db) == 2
    finally:
        await db.close()
    assert (await vectors())["To be corrected."] == embeddings.pack(
        [float(len("To be corrected.")), 1.0])


async def test_a_fact_pinned_since_is_not_touched_and_not_restored_a_second_time(
        client, fake_provider):
    convo = await setup_conversation(client)
    await told_then_corrected(client, convo["id"])
    fact = await fact_named(client, convo["id"], "Alice died on the bridge.")
    await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": True})

    await remove_from(client, convo["id"], 11)

    assert await stored_facts(client, convo["id"]) == [
        ("Alice died on the bridge.", "state", 8, True, "auto")]


async def test_a_copy_that_says_what_a_person_wrote_is_not_restored_beside_it(
        client, fake_provider):
    convo = await setup_conversation(client)
    await told_then_corrected(client, convo["id"])
    await client.post(f"/api/conversations/{convo['id']}/memories",
                      json={"content": "Alice is alive."})

    await remove_from(client, convo["id"], 11)

    assert await stored_facts(client, convo["id"]) == [("Alice is alive.", "fact", 0, False, "user")]


async def test_a_fact_pinned_when_the_pass_ran_and_unpinned_since_is_not_lost(client, fake_provider):
    """It is the model's again, it comes from a turn that stays, and the next pass reads
    from after that turn: the copy is what still has it."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [{"content": "From a turn that stays.", "kind": "fact"}]})
    fact = await fact_named(client, convo_id, "From a turn that stays.")
    await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": True})
    await talk(client, convo_id, 1, first=5)
    await extract(client, convo_id, {"facts": []})  # a checkpoint at 10, the fact pinned
    await talk(client, convo_id, 4, first=6)
    await extract(client, convo_id, {"facts": []})  # and at 18
    await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": False})

    await remove_from(client, convo_id, 13)

    assert await stored_facts(client, convo_id) == [("From a turn that stays.", "fact", 8, False, "auto")]


async def test_a_fact_forgotten_does_not_come_back_with_a_rewind(client, fake_provider):
    convo = await setup_conversation(client)
    await told_then_corrected(client, convo["id"])
    fact = await fact_named(client, convo["id"], "Alice died on the bridge.")

    resp = await client.delete(f"/api/memories/{fact['id']}")

    assert resp.status_code == 204
    assert await copy_at(convo["id"], 8) == set() and await copy_at(convo["id"], 16) == set()
    await remove_from(client, convo["id"], 11)
    assert await names(client, convo["id"]) == set()


async def test_a_fact_forgotten_after_a_rewind_is_gone_from_the_older_copies_too(
        client, fake_provider):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 2)
    await extract(client, convo_id, {"facts": [{"content": "Early.", "kind": "fact"}]})
    await talk(client, convo_id, 2, first=3)
    await extract(client, convo_id, {"facts": []})
    await talk(client, convo_id, 2, first=5)
    await extract(client, convo_id, {"obsolete_facts": ["Early."]})
    await remove_from(client, convo_id, 11)  # back to the checkpoint at 8: it is there again
    fact = await fact_named(client, convo_id, "Early.")

    await client.delete(f"/api/memories/{fact['id']}")

    assert await copy_at(convo_id, 4) == set()
    await remove_from(client, convo_id, 7)
    assert await names(client, convo_id) == set()


async def test_a_persons_edit_reaches_the_copies(client, fake_provider):
    convo = await setup_conversation(client)
    await told_then_corrected(client, convo["id"])
    fact = await fact_named(client, convo["id"], "Alice died on the bridge.")

    await client.patch(f"/api/memories/{fact['id']}", json={"content": "Alice is my sister."})

    assert await copy_at(convo["id"], 8) == {"Alice is my sister."}
    assert await copy_at(convo["id"], 16) == {"Alice is my sister."}
    await remove_from(client, convo["id"], 11)
    assert await stored_facts(client, convo["id"]) == [("Alice is my sister.", "state", 8, False, "auto")]


async def test_pinning_does_not_touch_the_copies(client, fake_provider):
    convo = await setup_conversation(client)
    await told_then_corrected(client, convo["id"])
    fact = await fact_named(client, convo["id"], "Alice died on the bridge.")
    before = (await copy_at(convo["id"], 8), await copy_at(convo["id"], 16))

    await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": True})

    assert (await copy_at(convo["id"], 8), await copy_at(convo["id"], 16)) == before


async def test_only_the_newest_checkpoints_are_kept_and_an_older_cut_falls_back(
        client, fake_provider):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 1)
    db = await _connect()
    try:
        await db.executemany(
            "INSERT INTO messages (id, conversation_id, role, variants, active_index,"
            " position, meta, created_at) VALUES (?, ?, 'user', '[\"x\"]', 0, ?, '{}', 'then')",
            [(f"m{n}", convo_id, n) for n in range(3, 40)])
        await db.commit()
    finally:
        await db.close()
    await put_fact(convo_id, "From the start.", at=3)
    for position in range(3, 33):
        await read_up_to(convo_id, position, f"To {position}.")
    assert [c[0] for c in await checkpoints_of(convo_id)] == list(range(3, 33))

    await read_up_to(convo_id, 33, "To 33.")

    assert [c[0] for c in await checkpoints_of(convo_id)] == list(range(4, 34))
    assert await copy_at(convo_id, 3) == set()
    assert await copy_at(convo_id, 4) == {"From the start."}

    await remove_from(client, convo_id, 4)  # the cut is at 3, a checkpoint that went

    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (3, "")
    assert await names(client, convo_id) == {"From the start."}


async def test_a_pinned_fact_drawn_from_removed_turns_stays_at_the_end_of_the_story(
        client, fake_provider):
    """It is the only copy, and only the person may take it away. Its position comes back
    with the story, so that the prompt does not place it at a turn that no longer exists."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 4)
    await extract(client, convo["id"], {"facts": [{"content": "Late, and pinned.", "kind": "fact"}]})
    fact = await fact_named(client, convo["id"], "Late, and pinned.")
    await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": True})

    await remove_from(client, convo["id"], 5)

    assert await stored_facts(client, convo["id"]) == [("Late, and pinned.", "fact", 4, True, "auto")]

    await remove_from(client, convo["id"], 0)

    assert await stored_facts(client, convo["id"]) == [("Late, and pinned.", "fact", 0, True, "auto")]


# ---------- a branch holds its own copies ----------

async def test_a_branch_gets_the_facts_as_they_were_at_its_message_with_new_ids(
        client, fake_provider):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await told_then_corrected(client, convo_id)
    source_fact = await fact_named(client, convo_id, "Alice died on the bridge.")
    fork = await at_position(client, convo_id, 10)

    branch = (await client.post(f"/api/messages/{fork['id']}/branch")).json()

    assert await stored_facts(client, branch["id"]) == [("Alice is alive.", "state", 8, False, "auto")]
    assert (branch["memory_position"], branch["summary"]) == (8, "To 8.")
    carried = await fact_named(client, branch["id"], "Alice is alive.")
    assert carried["id"] != source_fact["id"]
    assert await copy_at(branch["id"], 8) == {"Alice is alive."}
    # And the source is as it was.
    assert await names(client, convo_id) == {"Alice died on the bridge."}
    assert await copy_at(convo_id, 8) == {"Alice is alive."}


async def test_what_a_person_does_in_a_branch_stays_in_it(client, fake_provider):
    """The copies of a branch name its own facts, so forgetting one there reaches them,
    and not those of the conversation it came from."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await told_then_corrected(client, convo_id)
    fork = await at_position(client, convo_id, 10)
    branch = (await client.post(f"/api/messages/{fork['id']}/branch")).json()
    carried = await fact_named(client, branch["id"], "Alice is alive.")

    await client.delete(f"/api/memories/{carried['id']}")

    assert await copy_at(branch["id"], 8) == set()
    assert await copy_at(convo_id, 8) == {"Alice is alive."}

    # And the same in the other direction, through a branch of the branch.
    fork = await at_position(client, convo_id, 10)
    second = (await client.post(f"/api/messages/{fork['id']}/branch")).json()
    fork = await at_position(client, second["id"], 9)
    third = (await client.post(f"/api/messages/{fork['id']}/branch")).json()
    source_fact = await fact_named(client, convo_id, "Alice died on the bridge.")
    await client.delete(f"/api/memories/{source_fact['id']}")
    assert await copy_at(convo_id, 8) == set()
    assert await copy_at(second["id"], 8) == {"Alice is alive."}
    assert await copy_at(third["id"], 8) == {"Alice is alive."}
    assert await names(client, third["id"]) == {"Alice is alive."}


async def test_a_branch_copies_the_checkpoints_at_or_before_its_message_with_their_copies(
        client, fake_provider):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 2)
    await extract(client, convo_id, {"facts": [{"content": "At four.", "kind": "fact"}],
                                     "summary": "To 4."})
    await talk(client, convo_id, 2, first=3)
    await extract(client, convo_id, {"facts": [{"content": "At eight.", "kind": "fact"}],
                                     "summary": "To 8."})
    await talk(client, convo_id, 2, first=5)
    await extract(client, convo_id, {"facts": [{"content": "At twelve.", "kind": "fact"}],
                                     "summary": "To 12."})
    fork = await at_position(client, convo_id, 9)

    branch = (await client.post(f"/api/messages/{fork['id']}/branch")).json()

    assert await checkpoints_of(branch["id"]) == [(4, "To 4.", 4), (8, "To 8.", 8)]
    assert await copy_at(branch["id"], 4) == {"At four."}
    assert await copy_at(branch["id"], 8) == {"At four.", "At eight."}
    db = await _connect()
    try:
        ids = await (await db.execute(
            "SELECT DISTINCT fact_id FROM memory_checkpoint_facts WHERE conversation_id = ?",
            (branch["id"],))).fetchall()
    finally:
        await db.close()
    held = {f["id"] for f in (await client.get(f"/api/conversations/{branch['id']}/memories")).json()}
    assert {r["fact_id"] for r in ids} == held

    # A cut in the branch goes back through what it copied.
    await remove_from(client, branch["id"], 7)
    assert await names(client, branch["id"]) == {"At four."}
    read = await conversation(client, branch["id"])
    assert (read["memory_position"], read["summary"]) == (4, "To 4.")


async def test_a_branch_keeps_a_vector_only_beside_the_text_it_was_worked_out_from(
        client, fake_provider, monkeypatch):
    from app.prompting import embeddings

    async def embed(texts, kind):
        return [[float(len(text)), 1.0] for text in texts]

    monkeypatch.setattr(embeddings, "embed", embed)
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [{"content": "Stays as it is.", "kind": "fact"},
                                               {"content": "To be corrected.", "kind": "fact"}]})
    await talk(client, convo_id, 4, first=5)
    await extract(client, convo_id, {
        "updated_facts": [{"replaces": "To be corrected.", "content": "Corrected, much longer."}]})
    fork = await at_position(client, convo_id, 10)

    branch = (await client.post(f"/api/messages/{fork['id']}/branch")).json()

    db = await _connect()
    try:
        rows = await (await db.execute("SELECT content, embedding FROM memories"
                                       " WHERE conversation_id = ?", (branch["id"],))).fetchall()
    finally:
        await db.close()
    held = {r["content"]: r["embedding"] for r in rows}
    assert held["Stays as it is."] == embeddings.pack([float(len("Stays as it is.")), 1.0])
    assert held["To be corrected."] is None


# ---------- a pass is written whole, or not at all ----------

async def a_memory_to_change(client, convo_id):
    """Facts for an answer to correct and to drop, and turns for it to read."""
    await talk(client, convo_id, 2)
    await extract(client, convo_id, {"facts": [{"content": "To correct.", "kind": "fact"},
                                               {"content": "To drop.", "kind": "fact"}],
                                     "summary": "Before."})
    await talk(client, convo_id, 2, first=3)


AN_ANSWER = {"facts": [{"content": "New.", "kind": "fact"}],
             "updated_facts": [{"replaces": "To correct.", "content": "Corrected."}],
             "obsolete_facts": ["To drop."],
             "summary": "After."}


@pytest.mark.parametrize("trigger", [
    "BEFORE INSERT ON memories WHEN new.content = 'New.'",
    "BEFORE UPDATE OF content ON memories",
    "BEFORE DELETE ON memories",
    "BEFORE UPDATE OF memory_position ON conversations",
    "BEFORE INSERT ON memory_checkpoints",
    "BEFORE INSERT ON memory_checkpoint_facts",
], ids=["add", "correct", "drop", "position", "checkpoint", "copy"])
async def test_a_pass_that_breaks_at_any_step_leaves_nothing_of_it(client, fake_provider, trigger):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await a_memory_to_change(client, convo_id)
    before = (await stored_facts(client, convo_id), await checkpoints_of(convo_id),
              await copy_at(convo_id, 4))
    db = await _connect()
    try:
        await db.execute(f"CREATE TRIGGER refuse {trigger} BEGIN SELECT RAISE(ABORT, 'refused'); END")
        await db.commit()
    finally:
        await db.close()
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps(AN_ANSWER)),
                            ProviderEvent(type="done")]

    with pytest.raises(Exception, match="refused"):
        await client.post(f"/api/conversations/{convo_id}/memories/extract")

    assert (await stored_facts(client, convo_id), await checkpoints_of(convo_id),
            await copy_at(convo_id, 4)) == before
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (4, "Before.")
    # And the database is not left held by what failed.
    db = await _connect()
    try:
        await db.execute("DROP TRIGGER refuse")
        await db.commit()
    finally:
        await db.close()
    answered = await extract(client, convo_id, AN_ANSWER)
    assert [f["content"] for f in answered["facts_added"]] == ["New."]


@pytest.mark.parametrize("change", ["forgotten", "edited"])
async def test_a_pass_is_refused_when_a_person_changed_a_fact_it_was_sent(
        client, fake_provider, monkeypatch, change):
    """What it decided was decided on the fact as it was. A correction of a fact that a
    person has just forgotten would bring it back in other words."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await a_memory_to_change(client, convo_id)
    fact = await fact_named(client, convo_id, "To correct.")

    class ChangesWhileAnswering(FakeProvider):
        async def stream_chat(self, payload):
            if change == "forgotten":
                await client.delete(f"/api/memories/{fact['id']}")
            else:
                await client.patch(f"/api/memories/{fact['id']}", json={"content": "By hand."})
            async for event in super().stream_chat(payload):
                yield event

    monkeypatch.setattr("app.services.memory_service.get_provider", ChangesWhileAnswering)
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps(AN_ANSWER)),
                            ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo_id}/memories/extract")

    assert resp.status_code == 200, resp.text
    assert resp.json()["skipped"] == "changed"
    left = {"To drop."} | ({"By hand."} if change == "edited" else set())
    assert await names(client, convo_id) == left
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (4, "Before.")
    assert [c[0] for c in await checkpoints_of(convo_id)] == [4]


async def test_a_fact_added_by_hand_while_the_model_answers_does_not_stop_the_pass(
        client, fake_provider, monkeypatch):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await a_memory_to_change(client, convo_id)

    class AddsWhileAnswering(FakeProvider):
        async def stream_chat(self, payload):
            await client.post(f"/api/conversations/{convo_id}/memories", json={"content": "By hand."})
            async for event in super().stream_chat(payload):
                yield event

    monkeypatch.setattr("app.services.memory_service.get_provider", AddsWhileAnswering)
    answered = await extract(client, convo_id, AN_ANSWER)

    assert "skipped" not in answered
    assert await names(client, convo_id) == {"By hand.", "New.", "Corrected."}


async def test_a_cut_that_comes_while_a_pass_commits_waits_for_it(client, fake_provider, monkeypatch):
    """The two cannot cross: the cut starts once the pass has written all it had to, and
    goes back through what it wrote."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await a_memory_to_change(client, convo_id)
    cutting = []
    real = convo_repo.checkpoint

    async def checkpoint_and_meanwhile(*args):
        cutting.append(asyncio.create_task(remove_from(client, convo_id, 7)))
        await asyncio.sleep(0.2)  # long enough for it to reach the database, if it could
        assert not cutting[0].done()
        await real(*args)

    monkeypatch.setattr(convo_repo, "checkpoint", checkpoint_and_meanwhile)
    answered = await extract(client, convo_id, AN_ANSWER)
    monkeypatch.setattr(convo_repo, "checkpoint", real)
    await within(10, cutting[0])

    assert "skipped" not in answered
    assert await names(client, convo_id) == {"To correct.", "To drop."}
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (4, "Before.")
    assert await checkpoints_of(convo_id) == [(4, "Before.", 4)]


# ---------- a consolidation too ----------

MERGED_FACTS = {"facts": [{"content": "All of it, merged."}]}


async def facts_to_merge(client, convo_id):
    await talk(client, convo_id, 2)
    await extract(client, convo_id, {"facts": [{"content": f"Early {n}.", "kind": "fact"}
                                               for n in range(4)], "summary": "To 4."})
    await talk(client, convo_id, 2, first=3)
    await extract(client, convo_id, {"facts": [{"content": f"Late {n}.", "kind": "fact"}
                                               for n in range(4)], "summary": "To 8."})


async def test_a_cut_while_the_model_merges_leaves_no_merged_fact(
        client, fake_provider, monkeypatch):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await facts_to_merge(client, convo_id)
    started, release, _ = waiting_provider(monkeypatch)
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps(MERGED_FACTS)),
                            ProviderEvent(type="done")]

    merging = asyncio.create_task(client.post(f"/api/conversations/{convo_id}/memories/consolidate"))
    try:
        await within(5, started.wait())
        await remove_from(client, convo_id, 5)
    finally:
        release.set()
    answered = await within(5, merging)

    assert answered.json()["skipped"] == "changed"
    assert await names(client, convo_id) == {f"Early {n}." for n in range(4)}
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (4, "To 4.")


async def test_a_cut_while_the_vectors_of_a_merge_are_worked_out_leaves_no_merged_fact(
        client, fake_provider, monkeypatch):
    from app.prompting import embeddings

    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await facts_to_merge(client, convo_id)
    in_the_vectors, go_on = asyncio.Event(), asyncio.Event()

    async def embed(texts, kind):
        in_the_vectors.set()
        await go_on.wait()

    monkeypatch.setattr(embeddings, "embed", embed)
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps(MERGED_FACTS)),
                            ProviderEvent(type="done")]

    merging = asyncio.create_task(client.post(f"/api/conversations/{convo_id}/memories/consolidate"))
    try:
        await within(5, in_the_vectors.wait())
        await remove_from(client, convo_id, 5)
    finally:
        go_on.set()
    answered = await within(5, merging)

    assert answered.json()["skipped"] == "changed"
    assert await names(client, convo_id) == {f"Early {n}." for n in range(4)}


async def test_a_cut_that_leaves_every_fact_sent_leaves_the_merge(client, fake_provider, monkeypatch):
    """The turns it took are not ones the facts were drawn from, and the merged fact takes
    the oldest position of those it replaces: it cannot be past the end."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await facts_to_merge(client, convo_id)
    await talk(client, convo_id, 2, first=5)
    started, release, _ = waiting_provider(monkeypatch)
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps(MERGED_FACTS)),
                            ProviderEvent(type="done")]

    merging = asyncio.create_task(client.post(f"/api/conversations/{convo_id}/memories/consolidate"))
    try:
        await within(5, started.wait())
        await remove_from(client, convo_id, 9)
    finally:
        release.set()
    answered = await within(5, merging)

    assert "skipped" not in answered.json()
    assert await stored_facts(client, convo_id) == [("All of it, merged.", "fact", 4, False, "auto")]


# ---------- a summary asked for ----------

@pytest.fixture()
def slow_summary(monkeypatch):
    """The model that writes a summary asked for does not answer until ``go_on`` is set."""
    asked, go_on = asyncio.Event(), asyncio.Event()

    class Slow(Replies):
        async def stream_chat(self, payload):
            if "[Write the summary" in payload.messages[-1]["content"]:
                asked.set()
                await go_on.wait()
                yield ProviderEvent(type="delta", text="Written when asked for.")
                yield ProviderEvent(type="done")
                return
            async for event in super().stream_chat(payload):
                yield event

    monkeypatch.setattr("app.services.chat_service.get_provider", Slow)
    return asked, go_on


async def test_a_cut_while_the_model_writes_a_summary_leaves_no_summary_of_removed_turns(
        client, fake_provider, slow_summary):
    asked, go_on = slow_summary
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 2)
    await extract(client, convo_id, {"facts": [], "summary": "To 4."})
    await talk(client, convo_id, 2, first=3)

    writing = asyncio.create_task(client.post(f"/api/conversations/{convo_id}/summarize"))
    try:
        await within(5, asked.wait())
        await remove_from(client, convo_id, 7)
    finally:
        go_on.set()
    answered = await within(5, writing)

    assert answered.status_code == 200, answered.text
    assert answered.json()["skipped"] == "changed"
    assert answered.json()["summary"] == "To 4."
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (4, "To 4.")
    assert await checkpoints_of(convo_id) == [(4, "To 4.", 4)]


async def test_a_conversation_deleted_while_the_model_writes_a_summary_writes_nothing(
        client, fake_provider, slow_summary):
    asked, go_on = slow_summary
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 1)

    writing = asyncio.create_task(client.post(f"/api/conversations/{convo['id']}/summarize"))
    try:
        await within(5, asked.wait())
        assert (await client.delete(f"/api/conversations/{convo['id']}")).status_code == 204
    finally:
        go_on.set()
    answered = await within(5, writing)

    assert answered.status_code == 200, answered.text
    assert answered.json()["skipped"] == "changed"
    assert await checkpoints_of(convo["id"]) == []


async def test_a_turn_sent_while_the_model_writes_a_summary_does_not_stop_it(
        client, fake_provider, slow_summary):
    """It is true of the turns it was given, and is checkpointed at the last of them."""
    asked, go_on = slow_summary
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 2)  # positions 0 to 4

    writing = asyncio.create_task(client.post(f"/api/conversations/{convo_id}/summarize"))
    try:
        await within(5, asked.wait())
        await send(client, convo_id, content="Sent meanwhile")
    finally:
        go_on.set()
    answered = await within(5, writing)

    assert "skipped" not in answered.json()
    assert answered.json()["summary"] == "Written when asked for."
    assert await checkpoints_of(convo_id) == [(4, "Written when asked for.", 0)]


@pytest.mark.parametrize("trigger", ["BEFORE INSERT ON memory_checkpoints",
                                     "BEFORE INSERT ON memory_checkpoint_facts"],
                         ids=["checkpoint", "copy"])
async def test_a_summary_that_cannot_be_checkpointed_is_not_written(client, fake_provider, trigger):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 2)
    await extract(client, convo_id, {"facts": [{"content": "Known.", "kind": "fact"}], "summary": "To 4."})
    db = await _connect()
    try:
        await db.execute(f"CREATE TRIGGER refuse {trigger} BEGIN SELECT RAISE(ABORT, 'refused'); END")
        await db.commit()
    finally:
        await db.close()

    with pytest.raises(Exception, match="refused"):
        await client.post(f"/api/conversations/{convo_id}/summarize")

    assert (await conversation(client, convo_id))["summary"] == "To 4."


async def test_a_summary_asked_for_during_a_pass_says_so_and_asks_no_model(
        client, fake_provider, monkeypatch):
    """A pass and a summary each read the summary and write over it: they cannot cross."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 2)
    started, release, _ = waiting_provider(monkeypatch)
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps(
        {"facts": [], "summary": "From the pass."})), ProviderEvent(type="done")]
    told = []

    class Counts(Replies):
        async def stream_chat(self, payload):
            told.append(payload)
            async for event in super().stream_chat(payload):
                yield event

    monkeypatch.setattr("app.services.chat_service.get_provider", Counts)
    reading = asyncio.create_task(client.post(f"/api/conversations/{convo_id}/memories/extract"))
    try:
        await within(5, started.wait())
        answered = await within(5, client.post(f"/api/conversations/{convo_id}/summarize"))
    finally:
        release.set()
    await within(5, reading)

    assert answered.status_code == 200, answered.text
    assert answered.json()["skipped"] == "busy"
    assert answered.json()["id"] == convo_id
    assert told == []
    assert (await conversation(client, convo_id))["summary"] == "From the pass."


@pytest.mark.parametrize("task", ["extract", "consolidate"])
async def test_a_pass_or_a_consolidation_during_a_summary_asked_for_says_so(
        client, fake_provider, slow_summary, task):
    asked, go_on = slow_summary
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 2)
    fake_provider.captured.clear()

    writing = asyncio.create_task(client.post(f"/api/conversations/{convo_id}/summarize"))
    try:
        await within(5, asked.wait())
        answered = await within(5, client.post(f"/api/conversations/{convo_id}/memories/{task}"))
    finally:
        go_on.set()
    summary = await within(5, writing)

    assert answered.json()["skipped"] == "busy"
    assert fake_provider.captured == {}
    assert summary.json()["summary"] == "Written when asked for."


async def test_a_summary_that_fails_lets_the_next_task_run(client, fake_provider, monkeypatch):
    from app.errors import MODEL_ERROR

    class Fails(Replies):
        async def stream_chat(self, payload):
            yield ProviderEvent(type="error", message="Down.", meta={"kind": MODEL_ERROR})

    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)
    monkeypatch.setattr("app.services.chat_service.get_provider", Fails)

    assert (await client.post(f"/api/conversations/{convo['id']}/summarize")).status_code >= 400

    answered = await extract(client, convo["id"], {"facts": [], "summary": "To 4."})
    assert "skipped" not in answered
