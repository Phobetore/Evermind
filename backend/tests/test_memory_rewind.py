"""What a conversation remembers when its story is cut back: messages removed from a
point on, or a branch made at one.

Memory is tied to the story by positions: a fact says the newest turn that the pass
which drew it had read (``source_position``), the conversation says how far the memory
has read (``memory_position``), and each pass keeps the summary it left at the position it
read to. Positions are reused once the messages that held them are gone, so a memory that
does not follow the story back is wrong in three ways: facts born of turns that no longer
exist stay canon, the passes that should come next wait for new turns to pass an old mark,
and the summary describes a story that was never told.

Cutting the story back goes to the last pass at or before the cut: the memory has read what
it had read then and has its summary, the model's facts of later turns go, and a fact it
corrected since says again what it said before. The next pass reads the range between.
"""

import asyncio
import json

import pytest

from app.db import _connect
from app.prompting import embeddings
from app.providers.base import ProviderEvent
from app.repositories import conversations as convo_repo
from app.repositories import memories as memories_repo
from app.services import memory_service

from .test_chat import FakeProvider, send, setup_conversation
from .test_memory import extract, stored_facts, waiting_provider, within


class Replies:
    """The model that plays the story: a short reply to anything, or what ``text`` says.
    The memory passes talk to the scripted one, so that what each is told is not mixed up."""

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
    """As if a pass had read the story up to ``position`` and written ``summary``."""
    db = await _connect()
    try:
        await convo_repo.remember(db, convo_id, position, summary)
        await db.commit()
    finally:
        await db.close()


async def summaries_of(convo_id):
    db = await _connect()
    try:
        rows = await (await db.execute(
            "SELECT position, summary FROM memory_summaries WHERE conversation_id = ?"
            " ORDER BY position", (convo_id,))).fetchall()
        return [tuple(r) for r in rows]
    finally:
        await db.close()


async def remove_from(client, convo_id, position):
    message = await at_position(client, convo_id, position)
    resp = await client.delete(f"/api/messages/{message['id']}")
    assert resp.status_code == 204, resp.text


async def branch_at(client, convo_id, position):
    fork = await at_position(client, convo_id, position)
    resp = await client.post(f"/api/messages/{fork['id']}/branch")
    assert resp.status_code == 201, resp.text
    return resp.json()


async def names(client, convo_id):
    return {m["content"] for m in
            (await client.get(f"/api/conversations/{convo_id}/memories")).json()}


async def fact_named(client, convo_id, content):
    facts = (await client.get(f"/api/conversations/{convo_id}/memories")).json()
    return next(f for f in facts if f["content"] == content)


async def told_then_corrected(client, convo_id):
    """Talk to 8, a pass adds a fact; talk to 16, a pass corrects it."""
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [{"content": "Alice is alive."}],
                                     "summary": "To 8."})
    await talk(client, convo_id, 4, first=5)
    await extract(client, convo_id, {
        "updated_facts": [{"replaces": "Alice is alive.", "content": "Alice died on the bridge."}],
        "summary": "To 16."})


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
# The memory had one pass, at the position it had read to, so a cut before it has
# nothing to go back to.
REWINDS = [
    (8, 5, 0, False),  # the memory had read turns that are gone, and has no earlier pass
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


# A pass at 4 and one at 8, then a cut: the memory goes back to the last pass at or before
# the cut, with its summary, and the passes after it go.
CUTS = [
    (9, 8, "The story to 8.", [4, 8]),  # the cut leaves everything read: nothing moves
    (8, 4, "The story to 4.", [4]),
    (5, 4, "The story to 4.", [4]),
    (4, 0, "", []),                     # before the first pass
]


@pytest.mark.parametrize(("removed_from", "position", "summary", "kept"), CUTS)
async def test_a_cut_goes_back_to_the_last_pass_at_or_before_it(
        client, fake_provider, removed_from, position, summary, kept):
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 5)  # positions 0 to 10
    await read_up_to(convo["id"], 4, "The story to 4.")
    await read_up_to(convo["id"], 8, "The story to 8.")

    await remove_from(client, convo["id"], removed_from)

    read = await conversation(client, convo["id"])
    assert (read["memory_position"], read["summary"]) == (position, summary)
    assert [p for p, _ in await summaries_of(convo["id"])] == kept


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
    assert await summaries_of(convo["id"]) == []
    read = await conversation(client, convo["id"])
    assert (read["memory_position"], read["summary"]) == (0, "")


async def test_removing_a_message_removes_the_story_from_it_on(client, fake_provider):
    """The memory read the turns after it with it in the story, and nothing says what they
    drew from it: the story stops before it, and so does the memory."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await told_then_corrected(client, convo_id)
    message = await at_position(client, convo_id, 11)

    resp = await client.delete(f"/api/messages/{message['id']}")

    assert resp.status_code == 204
    assert [m["position"] for m in await messages_of(client, convo_id)] == list(range(11))
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (8, "To 8.")
    assert await stored_facts(client, convo_id) == [("Alice is alive.", 8, False, "auto")]
    assert await summaries_of(convo_id) == [(8, "To 8.")]

    fake_provider.captured.clear()
    await extract(client, convo_id, {"facts": [], "summary": "Again."})
    shown = fake_provider.captured["payload"].messages[0]["content"]
    assert "(turn 9)" in shown and "(turn 10)" in shown
    assert "(turn 11)" not in shown and "(turn 8)" not in shown
    assert (await conversation(client, convo_id))["memory_position"] == 10


async def test_a_pass_that_read_only_the_first_message_has_read_nothing_as_far_as_a_position_says(
        client, fake_provider, monkeypatch):
    """Position 0 still means nothing was read, so the next pass reads it again, and what
    it says again is not recorded twice."""
    class Stops:
        def __init__(self, connection):
            pass

        async def stream_chat(self, payload):
            yield ProviderEvent(type="done")

    monkeypatch.setattr("app.services.chat_service.get_provider", Stops)
    convo = await setup_conversation(client, greeting="")
    convo_id = convo["id"]
    await send(client, convo_id, content="Only this.")
    assert [m["position"] for m in await messages_of(client, convo_id)] == [0]

    first = await extract(client, convo_id, {"facts": [{"content": "Learned."}],
                                             "summary": "Just this."})
    assert [f["source_position"] for f in first["facts_added"]] == [0]
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (0, "Just this.")

    fake_provider.captured.clear()
    again = await extract(client, convo_id, {"facts": [{"content": "Learned."}]})
    assert "(turn 0): Only this." in fake_provider.captured["payload"].messages[0]["content"]
    assert again["facts_added"] == []
    assert await names(client, convo_id) == {"Learned."}
    assert await summaries_of(convo_id) == [(0, "Just this.")]


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
        "facts": [{"content": "Learned early."}],
        "summary": "The first four exchanges."})
    assert [f["source_position"] for f in first["facts_added"]] == [8]
    await talk(client, convo_id, 4, label="old exchange", first=5)  # positions 9 to 16
    await extract(client, convo_id, {
        "facts": [{"content": "Learned from turn 9."},
                  {"content": "Learned in removed turns."}],
        "summary": "Eight exchanges."})
    assert (await conversation(client, convo_id))["memory_position"] == 16

    await remove_from(client, convo_id, 11)

    rewound = await conversation(client, convo_id)
    assert (rewound["memory_position"], rewound["summary"]) == (8, "The first four exchanges.")
    assert await names(client, convo_id) == {"Kept by hand.", "Learned early."}
    assert await summaries_of(convo_id) == [(8, "The first four exchanges.")]

    await talk(client, convo_id, memory_service.MAINTENANCE_EVERY, label="new exchange")  # from 11
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
        "facts": [{"content": "Learned from turn 9."},
                  {"content": "Learned afterwards."}],
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
    end = 10 + 2 * memory_service.MAINTENANCE_EVERY
    assert [(f[0], f[1]) for f in final] == [
        ("Kept by hand.", 0), ("Learned afterwards.", end), ("Learned early.", 8),
        ("Learned from turn 9.", end)]
    assert (await conversation(client, convo_id))["memory_position"] == end
    assert [p for p, _ in await summaries_of(convo_id)] == [8, end]


async def test_a_long_story_cut_back_gets_its_summary_back_and_not_a_rebuilt_one(
        client, fake_provider):
    """A pass reads at most 40 turns. After 500 turns and a cut in the middle, forgetting
    the summary would leave a new one to be written from the last 40 turns before the
    cut, the story to that point reduced to them. The pass at 240 has all of it."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    db = await _connect()
    try:
        await db.executemany(
            "INSERT INTO messages (id, conversation_id, role, variants, active_index,"
            " position, meta, created_at) VALUES (?, ?, ?, ?, 0, ?, '{}', '2026-01-01T00:00:00Z')",
            [(f"m{n:04d}", convo_id, "user" if n % 2 else "assistant",
              json.dumps([f"Turn number {n}."]), n) for n in range(1, 501)])
        for n in range(40, 481, 40):
            await convo_repo.remember(db, convo_id, n, f"Summary to {n}.")
        await db.commit()
    finally:
        await db.close()

    await remove_from(client, convo_id, 250)

    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (240, "Summary to 240.")
    assert [p for p, _ in await summaries_of(convo_id)] == list(range(40, 241, 40))
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
    assert [p for p, _ in await summaries_of(convo["id"])] == [4]
    # Still theirs at the point the memory went back to, through the next cut.
    await remove_from(client, convo["id"], 3)
    read = await conversation(client, convo["id"])
    assert (read["memory_position"], read["summary"]) == (0, "In my own words.")


SELENA = "Selena woke in the crypt."
SERANA = "Serana (not Selena) woke in the crypt."


async def put_right_then_read_on(client, convo_id):
    """A pass at 8 gets her name wrong, the person puts it right, and a pass at 16 writes its
    summary from theirs."""
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [], "summary": SELENA})
    await client.patch(f"/api/conversations/{convo_id}", json={"summary": SERANA})
    await talk(client, convo_id, 4, first=5)
    await extract(client, convo_id, {"facts": [], "summary": f"{SERANA} They left."})


@pytest.mark.parametrize("back", ["cut", "branch"])
async def test_a_summary_a_person_put_right_comes_back_past_the_pass_that_rewrote_it(
        client, fake_provider, back):
    """What they last saw at that point, never the version they had corrected."""
    convo_id = (await setup_conversation(client))["id"]
    await put_right_then_read_on(client, convo_id)

    if back == "cut":
        await remove_from(client, convo_id, 11)
        read = await conversation(client, convo_id)
    else:
        fork = await at_position(client, convo_id, 10)
        read = (await client.post(f"/api/messages/{fork['id']}/branch")).json()

    assert (read["memory_position"], read["summary"]) == (8, SERANA)


@pytest.mark.parametrize(("was", "position"), [
    ("To 8.", 8),  # what the memory holds: nothing was read since
    ("To 4.", 4),  # a pass wrote another since, of turns 5 to 8
    ("", 0),       # no pass wrote what it was typed over
])
async def test_a_summary_typed_over_an_older_one_leaves_the_turns_read_since_to_the_next_pass(
        client, fake_provider, was, position):
    """It tells what the person read when they began typing, and nothing of the turns a pass
    read meanwhile."""
    convo_id = (await setup_conversation(client))["id"]
    for first, read in ((1, 4), (3, 8)):
        await talk(client, convo_id, 2, first=first)
        await extract(client, convo_id, {"facts": [], "summary": f"To {read}."})

    await client.patch(f"/api/conversations/{convo_id}", json={"summary": "Typed.", "summary_was": was})

    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (position, "Typed.")
    assert (await summaries_of(convo_id))[-1] == (position, "Typed.")
    await talk(client, convo_id, 1, first=5)
    fake_provider.captured.clear()
    await extract(client, convo_id, {"facts": [], "summary": "Next."})
    shown = fake_provider.captured["payload"].messages[0]["content"]
    assert "CURRENT SUMMARY:\nTyped.\n" in shown
    assert f"(turn {position + 1})" in shown and f"(turn {position})" not in shown


@pytest.mark.parametrize(("before", "was"), [
    ("a pass, then a cut", "To 8."),  # typed over a summary the cut took away
    ("a pass", ""),                   # typed over none while a pass read on
    ("nothing", None),                # before any pass, which releases let any branch keep
], ids=["over one cut away", "over none, read since", "before any pass"])
async def test_a_summary_typed_over_one_no_pass_holds_is_no_pass_for_a_branch_to_go_back_to(
        client, fake_provider, before, was):
    """It goes to position 0 and may tell any turn the person had read, past a branch's message."""
    convo_id = (await setup_conversation(client))["id"]
    await talk(client, convo_id, 4)
    if before != "nothing":
        await extract(client, convo_id, {"facts": [], "summary": "To 8."})
    if before.endswith("cut"):
        await remove_from(client, convo_id, 7)

    await client.patch(f"/api/conversations/{convo_id}", json={"summary": "Typed.", "summary_was": was})

    assert (await conversation(client, convo_id))["memory_position"] == 0
    branch = await branch_at(client, convo_id, 2)
    assert (branch["memory_position"], branch["summary"]) == (0, "")
    assert (await conversation(client, convo_id))["summary"] == "Typed."


PREMISE = "Premise: a heist in Venice."
PUT_RIGHT = "Story to 8: Marco betrays the crew at 5, the vault floods at 7."


async def a_premise_then_a_pass(client, convo_id, origin):
    """The story to 2 with a summary that a person typed while the memory had read nothing, then a
    pass to 8."""
    if origin == "typed again after a cut emptied it":
        await talk(client, convo_id, 2)
        await extract(client, convo_id, {"facts": [], "summary": "To 4."})
        await remove_from(client, convo_id, 3)
    else:
        await talk(client, convo_id, 1)
    assert (await conversation(client, convo_id))["summary"] == ""
    if origin == "carried over from 3.0":  # as 015 leaves a story with a summary and nothing read
        db = await _connect()
        try:
            await db.execute("UPDATE conversations SET summary = ? WHERE id = ?",
                             (PREMISE, convo_id))
            await db.execute("INSERT INTO memory_summaries (conversation_id, position, summary,"
                             " typed) VALUES (?, 0, ?, 1)", (convo_id, PREMISE))
            await db.commit()
        finally:
            await db.close()
    else:
        await client.patch(f"/api/conversations/{convo_id}", json={"summary": PREMISE})
    await talk(client, convo_id, 3, first=2)
    await extract(client, convo_id, {"facts": [], "summary": "Story to 8."})


@pytest.mark.parametrize("cut", [False, True], ids=["branched", "cut back, then branched"])
@pytest.mark.parametrize(("origin", "put_right_over"), [
    ("typed before the first pass", None),
    ("typed before the first pass", "Story to 8."),
    ("typed before the first pass", PREMISE),  # begun before the pass, saved after it
    ("typed again after a cut emptied it", "Story to 8."),
    ("carried over from 3.0", "Story to 8."),
], ids=["typed before the first pass", "put right over the pass",
        "put right over it after the pass", "typed again after a cut emptied it, put right",
        "carried over from 3.0, put right"])
async def test_a_summary_typed_at_the_start_is_no_pass_for_a_branch_once_a_pass_read_past_it(
        client, fake_provider, origin, put_right_over, cut):
    """Nothing says how far it tells: any turn the person had read, past the branch's message for
    all anyone knows, and so may what they typed over it or a later pass. The story keeps both."""
    convo_id = (await setup_conversation(client))["id"]
    await a_premise_then_a_pass(client, convo_id, origin)
    if put_right_over:
        await client.patch(f"/api/conversations/{convo_id}",
                           json={"summary": PUT_RIGHT, "summary_was": put_right_over})
    if cut:
        await remove_from(client, convo_id, 5)
        read = await conversation(client, convo_id)
        kept = PUT_RIGHT if put_right_over else PREMISE  # what a person wrote stays with the story
        assert (read["memory_position"], read["summary"]) == (0, kept)

    branch = await branch_at(client, convo_id, 1)

    assert (branch["memory_position"], branch["summary"]) == (0, "")
    assert await summaries_of(branch["id"]) == []


LATER = "Put right: Marco betrays the crew, then the vault floods."


async def two_passes_and_the_later_put_right(client, greeting):
    """Passes at 8 and 16; or, with no greeting, one of message 0 alone (Remember while the first
    reply is written) and one at 7. Then the person puts the later pass's summary right."""
    convo_id = (await setup_conversation(client, greeting=greeting))["id"]
    if greeting:
        await talk(client, convo_id, 4)
        await extract(client, convo_id, {"facts": [], "summary": "To 8."})
        await talk(client, convo_id, 4, first=5)
    else:
        await talk(client, convo_id, 1)
        await read_up_to(convo_id, 0, "To 0.")
        await talk(client, convo_id, 3, first=2)
    await extract(client, convo_id, {"facts": [], "summary": "To the end."})
    await client.patch(f"/api/conversations/{convo_id}", json={"summary": LATER})
    return convo_id


@pytest.mark.parametrize(("greeting", "fork", "earlier"), [
    ("Hello.", 10, (8, "To 8.")),
    ("", 1, (0, "To 0.")),
], ids=["passes at 8 and 16", "a first pass of message 0 alone"])
async def test_a_summary_put_right_over_a_pass_goes_with_no_branch_made_before_that_pass(
        client, fake_provider, greeting, fork, earlier):
    """It tells that pass's turns, past the branch's message: the branch starts with what the memory
    had at its message. The story keeps the person's words."""
    convo_id = await two_passes_and_the_later_put_right(client, greeting)

    branch = await branch_at(client, convo_id, fork)

    assert (branch["memory_position"], branch["summary"]) == earlier
    assert await summaries_of(branch["id"]) == [earlier]
    assert (await conversation(client, convo_id))["summary"] == LATER


@pytest.mark.parametrize(("greeting", "removed_from", "fork", "kept_at"), [
    ("Hello.", 12, 10, 8),
    ("", 4, 1, 0),
], ids=["passes at 8 and 16", "a first pass of message 0 alone"])
async def test_a_summary_put_right_then_cut_back_before_its_pass_goes_with_no_branch(
        client, fake_provider, greeting, removed_from, fork, kept_at):
    """The cut keeps it on the earlier pass's row, in place of that pass's summary, and it still
    tells the turns of the later one: a branch made from there starts with none."""
    convo_id = await two_passes_and_the_later_put_right(client, greeting)
    await remove_from(client, convo_id, removed_from)
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (kept_at, LATER)

    branch = await branch_at(client, convo_id, fork)

    assert (branch["memory_position"], branch["summary"]) == (0, "")
    assert await summaries_of(branch["id"]) == []


async def test_a_branch_from_past_a_summary_a_cut_moved_back_goes_back_to_the_pass_before_it(
        client, fake_provider):
    """The person's words sit on the row of the pass at 8, still telling the turns to 16; the pass
    at 4 tells none past the branch's message."""
    convo_id = (await setup_conversation(client))["id"]
    for first, exchanges, read in ((1, 2, 4), (3, 2, 8), (5, 4, 16)):
        await talk(client, convo_id, exchanges, first=first)
        await extract(client, convo_id, {"facts": [], "summary": f"To {read}."})
    await client.patch(f"/api/conversations/{convo_id}", json={"summary": LATER})
    await remove_from(client, convo_id, 12)

    branch = await branch_at(client, convo_id, 10)

    assert (branch["memory_position"], branch["summary"]) == (4, "To 4.")
    assert await summaries_of(branch["id"]) == [(4, "To 4.")]
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (8, LATER)


async def test_a_summary_put_right_over_a_pass_stays_with_a_branch_from_after_it_through_a_cut(
        client, fake_provider):
    """A later pass that wrote none carries it on. A cut back to the pass it was put right over
    leaves it there as it was, of the turns up to that pass, and a branch made from there keeps it."""
    convo_id = (await setup_conversation(client))["id"]
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [], "summary": SELENA})
    await client.patch(f"/api/conversations/{convo_id}", json={"summary": SERANA})
    await talk(client, convo_id, 4, first=5)
    await extract(client, convo_id, {"facts": []})

    await remove_from(client, convo_id, 12)
    branch = await branch_at(client, convo_id, 10)

    assert (branch["memory_position"], branch["summary"]) == (8, SERANA)


async def test_a_pass_that_gives_no_summary_keeps_a_typed_one_as_typed(client, fake_provider):
    """Its row holds what the person typed, so that a cut back to it gives that back after a
    later pass has rewritten it."""
    convo_id = (await setup_conversation(client))["id"]
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [], "summary": SELENA})
    await client.patch(f"/api/conversations/{convo_id}", json={"summary": SERANA})
    await talk(client, convo_id, 4, first=5)
    await extract(client, convo_id, {"facts": []})
    await talk(client, convo_id, 4, first=9)
    await extract(client, convo_id, {"facts": [], "summary": f"{SERANA} Then the castle."})

    await remove_from(client, convo_id, 19)

    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (16, SERANA)
    await remove_from(client, convo_id, 4)
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (0, SERANA)


async def test_a_pass_that_was_reading_when_the_story_was_cut_leaves_nothing_of_it(
        client, fake_provider, monkeypatch):
    """The model answers about turns that are no longer there. What it learned from
    them is not canon, and the memory is not read up to a point the story no longer
    reaches, where new turns would then be taken for old ones."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 3)  # positions 0 to 6
    started, release, asked = waiting_provider(monkeypatch)
    FakeProvider.script = [ProviderEvent(type="delta", text=json.dumps({
        "facts": [{"content": "Learned from turns that went."}],
        "summary": "A story that was cut."})), ProviderEvent(type="done")]

    reading = asyncio.create_task(client.post(f"/api/conversations/{convo['id']}/memories/extract"))
    try:
        await within(5, started.wait())
        await remove_from(client, convo["id"], 3)
    finally:
        release.set()
    answered = await within(5, reading)

    assert answered.status_code == 409, answered.text
    assert answered.json()["kind"] == "conversation_changed"
    assert await names(client, convo["id"]) == set()
    read = await conversation(client, convo["id"])
    assert (read["memory_position"], read["summary"]) == (0, "")
    assert await summaries_of(convo["id"]) == []

    # The next pass starts from where the story is.
    await send(client, convo["id"], content="After the cut")
    asked.clear()
    again = await extract(client, convo["id"], {
        "facts": [{"content": "Learned after the cut."}]})
    assert [f["source_position"] for f in again["facts_added"]] == [4]
    assert "(turn 3): After the cut" in asked[0].messages[0]["content"]


async def test_a_pass_that_was_reading_is_kept_when_only_later_turns_were_added(
        client, fake_provider, monkeypatch):
    """Turns sent while the model reads are not a change to the ones it read."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 2)  # positions 0 to 4
    started, release, _ = waiting_provider(monkeypatch)
    FakeProvider.script = [ProviderEvent(type="delta", text=json.dumps({
        "facts": [{"content": "Learned meanwhile."}]})),
        ProviderEvent(type="done")]

    reading = asyncio.create_task(client.post(f"/api/conversations/{convo['id']}/memories/extract"))
    try:
        await within(5, started.wait())
        await send(client, convo["id"], content="Sent during the pass")
    finally:
        release.set()
    answered = await within(5, reading)

    assert answered.status_code == 200, answered.text
    assert [f["content"] for f in answered.json()["facts_added"]] == ["Learned meanwhile."]
    assert (await conversation(client, convo["id"]))["memory_position"] == 4


# ---------- what a cut does to a fact ----------

async def test_a_fact_a_later_pass_corrected_is_back_as_it_was(client, fake_provider):
    convo = await setup_conversation(client)
    await told_then_corrected(client, convo["id"])
    corrected = await fact_named(client, convo["id"], "Alice died on the bridge.")

    await remove_from(client, convo["id"], 11)

    assert await stored_facts(client, convo["id"]) == [("Alice is alive.", 8, False, "auto")]
    assert (await fact_named(client, convo["id"], "Alice is alive."))["id"] == corrected["id"]
    read = await conversation(client, convo["id"])
    assert (read["memory_position"], read["summary"]) == (8, "To 8.")


async def by_length(texts, kind):
    """A semantic model whose vector of a text says how long it is."""
    return [[float(len(text)), 1.0] for text in texts]


async def vectors():
    db = await _connect()
    try:
        rows = await (await db.execute("SELECT content, embedding FROM memories")).fetchall()
        return {r["content"]: r["embedding"] for r in rows}
    finally:
        await db.close()


async def test_a_restored_fact_never_has_the_vector_of_another_text(
        client, fake_provider, monkeypatch):
    convo = await setup_conversation(client)
    convo_id = convo["id"]

    monkeypatch.setattr(embeddings, "embed", by_length)
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [{"content": "Stays as it is."},
                                               {"content": "To be corrected."}]})
    await talk(client, convo_id, 4, first=5)
    await extract(client, convo_id, {
        "updated_facts": [{"replaces": "To be corrected.", "content": "Corrected, much longer."}]})

    await remove_from(client, convo_id, 11)

    held = await vectors()
    assert held["Stays as it is."] == embeddings.pack([float(len("Stays as it is.")), 1.0])
    assert held["To be corrected."] is None
    # The next start gives it the vector of the text it holds.
    async def loaded():
        return True

    monkeypatch.setattr(embeddings, "warmup", loaded)
    await memory_service.fill_vectors()
    assert (await vectors())["To be corrected."] == embeddings.pack(
        [float(len("To be corrected.")), 1.0])


async def test_a_fact_restated_as_it_is_keeps_its_vector_and_the_correction_a_cut_undoes(
        client, fake_provider, monkeypatch):
    convo_id = (await setup_conversation(client))["id"]
    monkeypatch.setattr(embeddings, "embed", by_length)
    await told_then_corrected(client, convo_id)
    await talk(client, convo_id, 4, first=9)
    same = "Alice died on the bridge."
    await extract(client, convo_id, {"updated_facts": [{"replaces": same, "content": same}]})

    await remove_from(client, convo_id, 19)  # back before the pass that restated it
    assert await vectors() == {same: embeddings.pack([float(len(same)), 1.0])}

    await remove_from(client, convo_id, 11)  # back before the pass that corrected it
    assert await vectors() == {"Alice is alive.": None}


async def test_a_fact_pinned_since_is_not_touched_and_not_restored_a_second_time(
        client, fake_provider):
    convo = await setup_conversation(client)
    await told_then_corrected(client, convo["id"])
    fact = await fact_named(client, convo["id"], "Alice died on the bridge.")
    await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": True})

    await remove_from(client, convo["id"], 11)

    assert await stored_facts(client, convo["id"]) == [
        ("Alice died on the bridge.", 8, True, "auto")]


@pytest.mark.parametrize("back", ["cut", "branch"])
async def test_a_fact_kept_by_a_pin_through_a_cut_forgets_the_correction_of_the_turns_that_went(
        client, fake_provider, back):
    """Unpinned later, the next cut would put back the text that correction replaced, even a cut
    of turns no pass has read."""
    convo_id = (await setup_conversation(client))["id"]
    await told_then_corrected(client, convo_id)
    fact = await fact_named(client, convo_id, "Alice died on the bridge.")
    await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": True})
    if back == "cut":
        await remove_from(client, convo_id, 11)
    else:
        fork = await at_position(client, convo_id, 10)
        convo_id = (await client.post(f"/api/messages/{fork['id']}/branch")).json()["id"]
        fact = await fact_named(client, convo_id, "Alice died on the bridge.")
    await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": False})
    await talk(client, convo_id, 2, first=20)

    await remove_from(client, convo_id, 14)

    assert await stored_facts(client, convo_id) == [("Alice died on the bridge.", 8, False, "auto")]


async def test_a_fact_a_person_writes_that_the_model_holds_becomes_theirs(client, fake_provider):
    """Rather than refused as there already: the model's copy would go with a cut or a merge."""
    convo_id = (await setup_conversation(client))["id"]
    await talk(client, convo_id, 4)
    await extract(client, convo_id, {"facts": [{"content": "The ring is cursed."}]})
    held = await fact_named(client, convo_id, "The ring is cursed.")
    url = f"/api/conversations/{convo_id}/memories"

    resp = await client.post(url, json={"content": "The ring is cursed.", "is_pinned": True})

    assert resp.status_code == 201, resp.text
    assert resp.json()["id"] == held["id"]
    await remove_from(client, convo_id, 7)
    assert await stored_facts(client, convo_id) == [("The ring is cursed.", 6, True, "user")]
    again = await client.post(url, json={"content": "The ring is cursed."})
    assert (again.status_code, again.json()["kind"]) == (400, "fact_exists")


class APassWritesFirst:
    """A connection on which a pass, from another, writes just before the first change made."""

    def __init__(self, db, write):
        self.db, self.write = db, write

    async def execute(self, sql, params=()):
        if self.write and sql.startswith("UPDATE"):
            write, self.write = self.write, None
            await write()
        return await self.db.execute(sql, params)

    def __getattr__(self, name):
        return getattr(self.db, name)


@pytest.mark.parametrize("change", ["corrected", "dropped"])
async def test_a_fact_a_person_writes_as_a_pass_changes_the_models_copy_is_theirs_as_written(
        client, fake_provider, change):
    """Found as the model's, then corrected or dropped by a pass before it is made theirs: what
    they typed becomes a fact of its own, not the model's new words, nor nothing."""
    convo_id = (await setup_conversation(client))["id"]
    held = await put_fact(convo_id, "The ring is cursed.", at=4)

    async def a_pass_writes():
        other = await _connect()
        try:
            if change == "corrected":
                await memories_repo.rewrite(other, held["id"], "The ring was cursed, then broken.", None, 8)
            else:
                await memories_repo.remove(other, held["id"])
            await other.commit()
        finally:
            await other.close()

    db = await _connect()
    try:
        saved = await memories_repo.add(APassWritesFirst(db, a_pass_writes), convo_id,
                                        "The ring is cursed.", is_pinned=True, source="user")
    finally:
        await db.close()

    assert saved and (saved["content"], saved["source"], saved["is_pinned"]) == (
        "The ring is cursed.", "user", True)
    corrected = {"The ring was cursed, then broken."} if change == "corrected" else set()
    assert await names(client, convo_id) == corrected | {"The ring is cursed."}


async def test_a_fact_a_person_rewrote_is_theirs_through_any_cut(client, fake_provider):
    """What they wrote replaced the model's words: no cut takes it back to them, nor away with
    the turns the model drew it from."""
    convo = await setup_conversation(client)
    await told_then_corrected(client, convo["id"])
    fact = await fact_named(client, convo["id"], "Alice died on the bridge.")

    await client.patch(f"/api/memories/{fact['id']}", json={"content": "Alice is my sister."})
    await remove_from(client, convo["id"], 11)

    assert await stored_facts(client, convo["id"]) == [("Alice is my sister.", 8, False, "user")]
    await remove_from(client, convo["id"], 6)
    assert await stored_facts(client, convo["id"]) == [("Alice is my sister.", 5, False, "user")]


async def test_a_fact_forgotten_does_not_come_back_with_a_rewind(client, fake_provider):
    convo = await setup_conversation(client)
    await told_then_corrected(client, convo["id"])
    fact = await fact_named(client, convo["id"], "Alice died on the bridge.")

    assert (await client.delete(f"/api/memories/{fact['id']}")).status_code == 204
    await remove_from(client, convo["id"], 11)

    assert await names(client, convo["id"]) == set()


async def test_a_pinned_fact_drawn_from_removed_turns_stays_at_the_end_of_the_story(
        client, fake_provider):
    """It is the only copy, and only the person may take it away. Its position comes back
    with the story, so that the prompt does not place it at a turn that no longer exists."""
    convo = await setup_conversation(client)
    await talk(client, convo["id"], 4)
    await extract(client, convo["id"], {"facts": [{"content": "Late, and pinned."}]})
    fact = await fact_named(client, convo["id"], "Late, and pinned.")
    await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": True})

    await remove_from(client, convo["id"], 5)

    assert await stored_facts(client, convo["id"]) == [("Late, and pinned.", 4, True, "auto")]

    await remove_from(client, convo["id"], 0)

    assert await stored_facts(client, convo["id"]) == [("Late, and pinned.", 0, True, "auto")]


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
    (8, 4, 0, False),  # the memory had read past the fork, and has no earlier pass
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
    assert [p for p, _ in await summaries_of(branch["id"])] == ([before] if summary_kept else [])


async def test_a_branch_gets_the_facts_as_they_were_at_its_message_with_new_ids(
        client, fake_provider):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await told_then_corrected(client, convo_id)
    source_fact = await fact_named(client, convo_id, "Alice died on the bridge.")
    fork = await at_position(client, convo_id, 10)

    branch = (await client.post(f"/api/messages/{fork['id']}/branch")).json()

    assert await stored_facts(client, branch["id"]) == [("Alice is alive.", 8, False, "auto")]
    assert (branch["memory_position"], branch["summary"]) == (8, "To 8.")
    assert (await fact_named(client, branch["id"], "Alice is alive."))["id"] != source_fact["id"]
    assert await summaries_of(branch["id"]) == [(8, "To 8.")]
    # And the source is as it was.
    assert await names(client, convo_id) == {"Alice died on the bridge."}
    assert await summaries_of(convo_id) == [(8, "To 8."), (16, "To 16.")]


async def test_a_cut_in_a_branch_goes_back_through_the_passes_it_was_given(client, fake_provider):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    for first, position in ((1, 4), (3, 8), (5, 12)):
        await talk(client, convo_id, 2, first=first)
        await extract(client, convo_id, {"facts": [{"content": f"At {position}."}],
                                         "summary": f"To {position}."})
    fork = await at_position(client, convo_id, 9)

    branch = (await client.post(f"/api/messages/{fork['id']}/branch")).json()

    assert await summaries_of(branch["id"]) == [(4, "To 4."), (8, "To 8.")]
    assert await names(client, branch["id"]) == {"At 4.", "At 8."}
    await remove_from(client, branch["id"], 7)
    assert await names(client, branch["id"]) == {"At 4."}
    read = await conversation(client, branch["id"])
    assert (read["memory_position"], read["summary"]) == (4, "To 4.")


# ---------- a pass is written whole, or not at all ----------

async def a_memory_to_change(client, convo_id):
    """Facts for an answer to correct and to drop, and turns for it to read."""
    await talk(client, convo_id, 2)
    await extract(client, convo_id, {"facts": [{"content": "To correct."},
                                               {"content": "To drop."}],
                                     "summary": "Before."})
    await talk(client, convo_id, 2, first=3)


AN_ANSWER = {"facts": [{"content": "New."}],
             "updated_facts": [{"replaces": "To correct.", "content": "Corrected."}],
             "obsolete_facts": ["To drop."],
             "summary": "After."}


@pytest.mark.parametrize("trigger", [
    "BEFORE INSERT ON memories WHEN new.content = 'New.'",
    "BEFORE UPDATE OF content ON memories",
    "BEFORE DELETE ON memories",
    "BEFORE UPDATE OF memory_position ON conversations",
    "BEFORE INSERT ON memory_summaries",
], ids=["add", "correct", "drop", "position", "summary"])
async def test_a_pass_that_breaks_at_any_step_leaves_nothing_of_it(client, fake_provider, trigger):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await a_memory_to_change(client, convo_id)
    before = (await stored_facts(client, convo_id), await summaries_of(convo_id))
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

    assert (await stored_facts(client, convo_id), await summaries_of(convo_id)) == before
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

    async def changes():
        if change == "forgotten":
            await client.delete(f"/api/memories/{fact['id']}")
        else:
            await client.patch(f"/api/memories/{fact['id']}", json={"content": "By hand."})

    while_the_model_answers(monkeypatch, changes)
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps(AN_ANSWER)),
                            ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo_id}/memories/extract")

    assert resp.status_code == 409, resp.text
    assert resp.json()["kind"] == "facts_changed"
    left = {"To drop."} | ({"By hand."} if change == "edited" else set())
    assert await names(client, convo_id) == left
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (4, "Before.")
    assert await summaries_of(convo_id) == [(4, "Before.")]


async def set_message(message_id, column, value):
    db = await _connect()
    try:
        await db.execute(f"UPDATE messages SET {column} = ? WHERE id = ?", (json.dumps(value), message_id))
        await db.commit()
    finally:
        await db.close()


@pytest.mark.parametrize("mode", ["send", "regenerate", "continue"])
async def test_remember_reads_no_further_than_a_reply_still_being_written(
        client, fake_provider, monkeypatch, mode):
    """What has come of it is not what it will say, and no pass would read the rest. The turn is a
    real one: how a reply says it is still being written belongs to the code that writes it."""
    convo_id = (await setup_conversation(client))["id"]
    await talk(client, convo_id, 1 if mode == "send" else 2)  # the reply written is the one at 4
    finish = asyncio.Event()

    class HalfWay:
        def __init__(self, connection):
            pass

        async def stream_chat(self, payload):
            yield ProviderEvent(type="delta", text="She opens the door.")
            await finish.wait()
            yield ProviderEvent(type="delta", text=" Behind it, the king lies dead.")
            yield ProviderEvent(type="done")

    async def half_written():
        while not any(m["position"] == 4 and m["content"].endswith("She opens the door.")
                      for m in await messages_of(client, convo_id)):
            await asyncio.sleep(0.01)

    monkeypatch.setattr("app.services.chat_service.get_provider", HalfWay)
    replying = asyncio.create_task(send(client, convo_id, content="Open it.", mode=mode))
    try:
        await within(5, half_written())
        await extract(client, convo_id, {"facts": [], "summary": "To 3."})
    finally:
        finish.set()
        await within(5, replying)

    assert "(turn 4)" not in fake_provider.captured["payload"].messages[0]["content"]
    assert (await conversation(client, convo_id))["memory_position"] == 3
    await extract(client, convo_id, {"facts": [], "summary": "To 4."})
    shown = fake_provider.captured["payload"].messages[0]["content"]
    before = "Reply. " if mode == "continue" else ""
    assert f"(turn 4): {before}She opens the door. Behind it, the king lies dead." in shown


@pytest.mark.parametrize("change", ["edited", "swiped"])
async def test_a_pass_is_refused_when_a_turn_it_read_changed_while_the_model_answered(
        client, fake_provider, monkeypatch, change):
    """The turn says something else now, as after a cut: what was drawn from it may not hold."""
    convo_id = (await setup_conversation(client))["id"]
    await a_memory_to_change(client, convo_id)
    reply = await at_position(client, convo_id, 8)
    await set_message(reply["id"], "variants", ["Reply.", "The guard lives."])

    async def changes():
        if change == "edited":
            await client.patch(f"/api/messages/{reply['id']}", json={"content": "The guard lives."})
        else:
            await client.patch(f"/api/messages/{reply['id']}", json={"active_index": 1})

    while_the_model_answers(monkeypatch, changes)
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps(AN_ANSWER)),
                            ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo_id}/memories/extract")

    assert resp.status_code == 409, resp.text
    assert resp.json()["kind"] == "conversation_changed"
    assert await names(client, convo_id) == {"To correct.", "To drop."}
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (4, "Before.")


@pytest.mark.parametrize(("edited", "kept"), [
    (5, True),    # read by the pass before
    (15, True),   # not read yet, but before the 40 turns a pass reads
    (21, False),  # the first of those the model was sent
])
async def test_a_typo_put_right_while_the_model_answers_refuses_the_pass_only_in_a_turn_it_was_sent(
        client, fake_provider, monkeypatch, edited, kept):
    """What the model was told of the other turns is nothing, and a cut changes their ids."""
    convo_id = await a_story_read_once(client, last=60, read=10)
    message = await at_position(client, convo_id, edited)

    async def puts_right():
        await client.patch(f"/api/messages/{message['id']}", json={"content": "Put right."})

    while_the_model_answers(monkeypatch, puts_right)
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps({"facts": [], "summary": "To 60."})),
                            ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo_id}/memories/extract")

    assert resp.status_code == (200 if kept else 409), resp.text
    assert (await conversation(client, convo_id))["memory_position"] == (60 if kept else 10)


async def test_a_fact_the_story_moved_back_while_the_model_merges_stops_the_merge(
        client, fake_provider, monkeypatch):
    """Pinned, kept past a cut at the end of the story, unpinned again: the same fact, with the
    same words, standing earlier. The merged fact would take the position it was sent with,
    past the end of the story."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 4)  # positions 0 to 8
    await extract(client, convo_id, {"facts": [{"content": f"Fact {n}."}
                                               for n in range(8)]})
    facts = (await client.get(f"/api/conversations/{convo_id}/memories")).json()

    async def pin_cut_unpin():
        for fact in facts:
            await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": True})
        await remove_from(client, convo_id, 5)
        for fact in facts:
            await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": False})

    while_the_model_answers(monkeypatch, pin_cut_unpin)
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps(
        {"facts": [{"content": "All of it, merged."}]})), ProviderEvent(type="done")]

    answered = await client.post(f"/api/conversations/{convo_id}/memories/consolidate")

    assert answered.status_code == 409, answered.text
    assert answered.json()["kind"] == "facts_changed"
    assert await stored_facts(client, convo_id) == [
        (f"Fact {n}.", 4, False, "auto") for n in range(8)]


# ---------- a long story keeps its summary ----------

async def a_story_read_once(client, last=500, read=492):
    """Turns 1 to ``last``, read once by a pass: a summary the model wrote, and no pass before it."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    db = await _connect()
    try:
        await db.executemany(
            "INSERT INTO messages (id, conversation_id, role, variants, active_index,"
            " position, meta, created_at) VALUES (?, ?, ?, ?, 0, ?, '{}', 'then')",
            [(f"m{n:04d}", convo_id, "user" if n % 2 else "assistant",
              json.dumps([f"Turn number {n}."]), n) for n in range(1, last + 1)])
        await convo_repo.remember(db, convo_id, read, "The whole story.")
        await db.commit()
    finally:
        await db.close()
    return convo_id


async def test_a_long_story_cut_before_its_only_pass_keeps_its_summary(
        client, fake_provider):
    """A pass reads 40 turns at most, so a summary written again would hold turns 450 to 489
    and nothing of the 450 before them. A summary part stale, which a person can read and
    correct, is worth more than that."""
    convo_id = await a_story_read_once(client)

    await remove_from(client, convo_id, 490)

    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (0, "The whole story.")
    assert await summaries_of(convo_id) == []
    fake_provider.captured.clear()
    await extract(client, convo_id, {"facts": [], "summary": "The whole story, and more."})
    shown = fake_provider.captured["payload"].messages[0]["content"]
    assert "CURRENT SUMMARY:\nThe whole story." in shown
    assert "(turn 450): Turn number 450." in shown and "(turn 489): Turn number 489." in shown
    assert "(turn 449)" not in shown


@pytest.mark.parametrize("typed", [False, True], ids=["by a pass", "typed"])
async def test_a_branch_from_before_any_pass_it_has_starts_with_no_summary(
        client, fake_provider, typed):
    """As releases did: that summary tells what comes after the message, in a story the branch
    is not. Its next pass writes one from the turns before it."""
    convo_id = await a_story_read_once(client)
    if typed:
        await client.patch(f"/api/conversations/{convo_id}", json={"summary": "My words."})
    fork = await at_position(client, convo_id, 200)

    branch = (await client.post(f"/api/messages/{fork['id']}/branch")).json()

    assert (branch["memory_position"], branch["summary"]) == (0, "")
    assert await summaries_of(branch["id"]) == []
    fake_provider.captured.clear()
    await extract(client, branch["id"], {"facts": [], "summary": "From 161 to 200."})
    shown = fake_provider.captured["payload"].messages[0]["content"]
    assert "CURRENT SUMMARY:\n(empty)" in shown
    assert "(turn 161)" in shown and "(turn 200)" in shown and "(turn 160)" not in shown


@pytest.mark.parametrize(("last", "removed_from", "fork", "typed"), [
    (500, 300, 200, False),  # kept because a pass would write it again from 40 turns only
    (500, 300, 200, True),   # kept because it is the person's
    (20, 10, 5, True),
], ids=["long, by a pass", "long, typed", "short, typed"])
async def test_a_branch_from_a_story_cut_before_its_only_pass_starts_with_no_summary(
        client, fake_provider, last, removed_from, fork, typed):
    """The cut keeps the summary at position 0, where it still tells turns past the message: a
    branch starts with none, as one made before the cut did, put right or read on since. A pass
    of the turns up to its message is one to go back to."""
    convo_id = await a_story_read_once(client, last=last, read=last - 2)
    if typed:
        await client.patch(f"/api/conversations/{convo_id}", json={"summary": "My words."})
    await remove_from(client, convo_id, removed_from)
    kept = await conversation(client, convo_id)
    assert (kept["memory_position"], kept["summary"]) == (0, "My words." if typed else "The whole story.")

    for then in ("cut", "put right", "read on"):
        if then == "put right":
            await client.patch(f"/api/conversations/{convo_id}", json={"summary": "Put right."})
        elif then == "read on":
            await extract(client, convo_id, {"facts": [], "summary": "Read on."})
        branch = await branch_at(client, convo_id, fork)
        assert (branch["memory_position"], branch["summary"]) == (0, ""), then
    branch = await branch_at(client, convo_id, removed_from - 1)
    assert (branch["memory_position"], branch["summary"]) == (removed_from - 1, "Read on.")


async def test_a_cut_in_a_branch_never_gives_it_the_summary_it_started_without(
        client, fake_provider):
    """A row of it left in the branch would be what a cut back past the branch's own first pass
    goes back to: the story after the branch's message, told in it."""
    convo_id = await a_story_read_once(client, last=20, read=18)
    await client.patch(f"/api/conversations/{convo_id}", json={"summary": "My words."})
    await remove_from(client, convo_id, 10)  # kept at 0, as telling turns up to 18
    branch_id = (await branch_at(client, convo_id, 5))["id"]
    await talk(client, branch_id, 2, first=100)
    await extract(client, branch_id, {"facts": [], "summary": "The branch, to 9."})

    await remove_from(client, branch_id, 8)

    read = await conversation(client, branch_id)
    assert (read["memory_position"], read["summary"]) == (0, "")


@pytest.mark.parametrize(("removed_from", "summary"), [
    (42, "The whole story."),
    (41, "The whole story."),  # the story is 41 turns, 0 to 40: one more than a pass reads
    (40, ""),                  # the story is 40 turns: the next pass writes it again
    (39, ""),
])
async def test_a_summary_goes_only_if_the_next_pass_can_write_it_again(
        client, fake_provider, removed_from, summary):
    convo_id = await a_story_read_once(client)

    await remove_from(client, convo_id, removed_from)

    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (0, summary)


# ---------- what a person changed while a pass was reading ----------

def while_the_model_answers(monkeypatch, action):
    class Acting(FakeProvider):
        async def stream_chat(self, payload):
            await action()
            async for event in super().stream_chat(payload):
                yield event

    monkeypatch.setattr("app.services.memory_service.get_provider", Acting)


@pytest.mark.parametrize("typed", ["In my own words.", ""], ids=["typed", "cleared"])
async def test_a_summary_typed_while_the_model_answers_is_kept_with_the_rest_of_the_pass(
        client, fake_provider, monkeypatch, typed):
    """What the model wrote, it wrote from the summary before that one, which would be lost
    with no trace. The facts are kept; the turns the pass read are in no summary yet, so the
    next pass reads them again, on top of what was typed."""
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await a_memory_to_change(client, convo_id)

    async def types():
        await client.patch(f"/api/conversations/{convo_id}", json={"summary": typed})

    while_the_model_answers(monkeypatch, types)
    answered = await extract(client, convo_id, AN_ANSWER)

    assert answered["summary"] == typed
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (4, typed)
    assert await names(client, convo_id) == {"New.", "Corrected."}
    assert await summaries_of(convo_id) == [(4, typed)]

    monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
    fake_provider.captured.clear()
    await extract(client, convo_id, {"facts": [], "summary": "Again."})
    shown = fake_provider.captured["payload"].messages[0]["content"]
    assert f"CURRENT SUMMARY:\n{typed or '(empty)'}\n" in shown
    assert "(turn 5)" in shown and "(turn 8)" in shown and "(turn 4)" not in shown


async def test_a_summary_typed_during_the_first_pass_reads_as_typed_too(
        client, fake_provider, monkeypatch):
    convo = await setup_conversation(client)
    convo_id = convo["id"]
    await talk(client, convo_id, 2)

    async def types():
        await client.patch(f"/api/conversations/{convo_id}", json={"summary": "In my own words."})

    while_the_model_answers(monkeypatch, types)
    await extract(client, convo_id, AN_ANSWER)

    assert await summaries_of(convo_id) == [(0, "In my own words.")]
    assert (await conversation(client, convo_id))["memory_position"] == 0
    await remove_from(client, convo_id, 3)
    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (0, "In my own words.")


async def test_a_summary_typed_while_a_pass_reads_comes_back_past_the_next_pass(
        client, fake_provider, monkeypatch):
    convo_id = (await setup_conversation(client))["id"]
    await talk(client, convo_id, 2)
    await extract(client, convo_id, {"facts": [], "summary": SELENA})
    await talk(client, convo_id, 2, first=3)

    async def types():
        await client.patch(f"/api/conversations/{convo_id}", json={"summary": SERANA})

    while_the_model_answers(monkeypatch, types)
    await extract(client, convo_id, {"facts": [], "summary": f"{SELENA} To 8."})
    monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
    await talk(client, convo_id, 4, first=5)
    await extract(client, convo_id, {"facts": [], "summary": f"{SERANA} To 16."})

    await remove_from(client, convo_id, 11)

    read = await conversation(client, convo_id)
    assert (read["memory_position"], read["summary"]) == (4, SERANA)
