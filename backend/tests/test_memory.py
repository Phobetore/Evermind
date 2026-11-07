"""Memory system tests: extraction, dedup, scheduling, injection, endpoints."""

import asyncio
import json

import pytest

from app.providers.base import ProviderEvent
from app.services import memory_service

from .test_chat import FakeProvider, send, setup_conversation

EXTRACTION_JSON = json.dumps({
    "facts": [
        {"content": "Aymeric broke the crypt seal."},
        {"content": "Serana distrusts Aymeric."},
    ],
    "summary": "Aymeric woke Serana by breaking the seal of her crypt.",
})


@pytest.fixture()
def fake_provider(monkeypatch):
    FakeProvider.script = [
        ProviderEvent(type="delta", text="*She smiles.* Hello."),
        ProviderEvent(type="done"),
    ]
    FakeProvider.captured = {}
    monkeypatch.setattr("app.services.chat_service.get_provider", FakeProvider)
    monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
    return FakeProvider


async def get_db_for_test(client):
    """Open a DB connection on the test's temp database."""
    from app.db import _connect

    return await _connect()


async def test_run_maintenance_stores_facts_and_summary(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])

    fake_provider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                            ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["facts_added"]) == 2
    assert body["summary"].startswith("Aymeric woke")

    memories = (await client.get(f"/api/conversations/{convo['id']}/memories")).json()
    assert {m["content"] for m in memories} == {
        "Aymeric broke the crypt seal.", "Serana distrusts Aymeric.",
    }
    # the extraction prompt received existing summary and turns
    payload = fake_provider.captured["payload"]
    assert "NEWEST TURNS" in payload.messages[0]["content"]
    assert "memory-keeper" in payload.system


async def test_second_extraction_dedups_and_advances(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    fake_provider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                            ProviderEvent(type="done")]
    await client.post(f"/api/conversations/{convo['id']}/memories/extract")

    # no new turns since memory_position advanced -> no LLM call, no dupes
    fake_provider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                            ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.json()["facts_added"] == []
    memories = (await client.get(f"/api/conversations/{convo['id']}/memories")).json()
    assert len(memories) == 2


async def test_extraction_tolerates_wrapped_json(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    fake_provider.script = [
        ProviderEvent(type="delta", text=f"Here is the memory:\n{EXTRACTION_JSON}\nThere."),
        ProviderEvent(type="done"),
    ]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.status_code == 200
    assert len(resp.json()["facts_added"]) == 2


async def test_extraction_error_returns_502(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    fake_provider.script = [ProviderEvent(type="delta", text="not json"),
                            ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.status_code == 502


async def test_is_due_after_threshold_and_setting(client, fake_provider):
    convo = await setup_conversation(client)
    # keep the auto background task from firing mid-test (its temp DB dies
    # with the test); re-enable to assert the threshold, disable to assert off
    await client.put("/api/settings", json={"auto_memory": False})
    db = await get_db_for_test(client)
    try:
        assert not await memory_service.is_due(db, convo["id"])
        for _ in range(memory_service.MAINTENANCE_EVERY):
            fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                                    ProviderEvent(type="done")]
            await send(client, convo["id"], content="encore")

        await client.put("/api/settings", json={"auto_memory": True})
        assert await memory_service.is_due(db, convo["id"])

        await client.put("/api/settings", json={"auto_memory": False})
        assert not await memory_service.is_due(db, convo["id"])
    finally:
        await db.close()


class Said:
    """The chat model: a reply that names the message it answers, so that what a pass was
    sent can be told from what it was not."""

    def __init__(self, connection):
        pass

    async def stream_chat(self, payload):
        yield ProviderEvent(type="delta", text=f"Reply to {payload.messages[-1]['content']}")
        yield ProviderEvent(type="done")


async def an_automatic_pass(client, monkeypatch):
    """A conversation whose replies have just made a pass due, with the pass done: the real
    ``schedule_if_due``, and a memory model that answers with ``EXTRACTION_JSON``."""
    monkeypatch.setattr("app.services.chat_service.get_provider", Said)
    monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
    FakeProvider.captured = {}
    FakeProvider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                           ProviderEvent(type="done")]
    convo = await setup_conversation(client)
    for n in range(memory_service.MAINTENANCE_EVERY):
        await send(client, convo["id"], content=f"exchange {n}")
    await asyncio.gather(*[t for t in asyncio.all_tasks() if "schedule_if_due" in repr(t)])
    return convo["id"]


async def test_an_automatic_pass_leaves_the_newest_messages_unread(client, monkeypatch):
    convo_id = await an_automatic_pass(client, monkeypatch)
    last = memory_service.MAINTENANCE_EVERY - 1

    asked = FakeProvider.captured["payload"].messages[0]["content"]
    assert "exchange 0" in asked
    assert f"exchange {last - 2}" in asked and f"exchange {last - 1}" not in asked
    read = (await client.get(f"/api/conversations/{convo_id}")).json()
    assert read["memory_position"] == 2 * memory_service.MAINTENANCE_EVERY - memory_service.HOLD_BACK
    assert len((await client.get(f"/api/conversations/{convo_id}/memories")).json()) == 2

    # Remember reads them all: the person asked for the story as it stands.
    await client.post(f"/api/conversations/{convo_id}/memories/extract")
    assert f"exchange {last}" in FakeProvider.captured["payload"].messages[0]["content"]
    read = (await client.get(f"/api/conversations/{convo_id}")).json()
    assert read["memory_position"] == 2 * memory_service.MAINTENANCE_EVERY


async def test_removing_the_last_reply_after_an_automatic_pass_costs_the_memory_nothing(
        client, monkeypatch):
    """A reply that is thrown away and written again was not read, so nothing of it is in
    the memory and nothing is taken back."""
    convo_id = await an_automatic_pass(client, monkeypatch)
    messages = (await client.get(f"/api/conversations/{convo_id}")).json()["messages"]

    resp = await client.delete(f"/api/messages/{messages[-1]['id']}")

    assert resp.status_code == 204
    read = (await client.get(f"/api/conversations/{convo_id}")).json()
    assert read["memory_position"] == 2 * memory_service.MAINTENANCE_EVERY - memory_service.HOLD_BACK
    assert read["summary"].startswith("Aymeric woke")
    assert len((await client.get(f"/api/conversations/{convo_id}/memories")).json()) == 2


async def test_a_pass_asks_for_room_to_answer_whatever_the_connection_allows(client, fake_provider):
    """A reply cut at a few hundred tokens leaves JSON that cannot be read, and every pass
    after it fails the same way."""
    convo = await setup_conversation(client)
    connection = (await client.get("/api/connections")).json()[0]
    await client.put(f"/api/connections/{connection['id']}", json={**connection, "max_tokens": 300})
    await send(client, convo["id"])
    fake_provider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                            ProviderEvent(type="done")]

    await client.post(f"/api/conversations/{convo['id']}/memories/extract")

    assert fake_provider.captured["connection"]["max_tokens"] == 2048


async def test_a_pass_sets_no_cap_on_a_connection_that_has_none(client, fake_provider):
    """Some providers refuse the field, and chat works without it."""
    convo = await setup_conversation(client)
    connection = (await client.get("/api/connections")).json()[0]
    await client.put(f"/api/connections/{connection['id']}", json={**connection, "max_tokens": None})
    await send(client, convo["id"])
    fake_provider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                            ProviderEvent(type="done")]

    await client.post(f"/api/conversations/{convo['id']}/memories/extract")

    assert fake_provider.captured["connection"]["max_tokens"] is None


async def test_a_failed_automatic_pass_waits_for_more_replies_and_says_why(
        client, monkeypatch, caplog):
    monkeypatch.setattr("app.services.chat_service.get_provider", Said)
    monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
    FakeProvider.captured = {}
    FakeProvider.script = [ProviderEvent(type="delta", text="not json"), ProviderEvent(type="done")]
    convo = await setup_conversation(client)
    every = memory_service.MAINTENANCE_EVERY

    async def reply(n):
        await send(client, convo["id"], content=f"exchange {n}")
        await asyncio.gather(*[t for t in asyncio.all_tasks() if "schedule_if_due" in repr(t)])

    for n in range(every):
        await reply(n)
    asked = FakeProvider.captured["payload"]
    failed = (await client.get(f"/api/conversations/{convo['id']}")).json()["memory_error"]
    assert failed["kind"] == "model_unreadable"
    assert not [r for r in caplog.records if r.exc_info], "a model's failure is no fault of the code"

    # Not again until `every - 1` more replies have come, however many are due.
    FakeProvider.captured = {}
    for n in range(every, 2 * every - 2):
        await reply(n)
    assert FakeProvider.captured == {}
    FakeProvider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                           ProviderEvent(type="done")]
    await reply(2 * every - 2)
    assert FakeProvider.captured["payload"] is not asked

    read = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert read["memory_error"] is None
    assert read["memory_position"] > 0


async def test_an_automatic_pass_that_a_cut_overtook_is_no_failure(client, monkeypatch):
    """The story changed while it read: the next reply asks again, and nothing went wrong."""
    monkeypatch.setattr("app.services.chat_service.get_provider", Said)
    started, release, _ = waiting_provider(monkeypatch)
    FakeProvider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                           ProviderEvent(type="done")]
    convo = await setup_conversation(client)
    for n in range(memory_service.MAINTENANCE_EVERY):
        await send(client, convo["id"], content=f"exchange {n}")
    try:
        await within(5, started.wait())
        messages = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
        assert (await client.delete(f"/api/messages/{messages[3]['id']}")).status_code == 204
    finally:
        release.set()
    await asyncio.gather(*[t for t in asyncio.all_tasks() if "schedule_if_due" in repr(t)])

    read = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert (read["memory_position"], read["memory_error"]) == (0, None)


async def test_a_pass_never_reads_a_message_out_of_character(client, fake_provider):
    convo = await setup_conversation(client)
    sent = await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "send", "message_mode": "ooc",
        "content": "Stop describing her eyes, and kill the innkeeper next scene."})
    assert sent.status_code == 200, sent.text
    fake_provider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                            ProviderEvent(type="done")]

    await client.post(f"/api/conversations/{convo['id']}/memories/extract")

    asked = fake_provider.captured["payload"].messages[0]["content"]
    assert "innkeeper" not in asked
    assert "Hello." in asked  # the reply to it is read
    read = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert read["memory_position"] == 2


async def test_facts_injected_into_chat_payload(client, fake_provider):
    convo = await setup_conversation(client)
    await client.post(f"/api/conversations/{convo['id']}/memories", json={
        "content": "Aymeric killed Serana's parents before her eyes.", "is_pinned": True,
    })
    await send(client, convo["id"])
    payload = fake_provider.captured["payload"]
    assert "### ESTABLISHED FACTS" in payload.system
    assert "killed Serana's parents" in payload.system


async def test_memory_crud(client, fake_provider):
    convo = await setup_conversation(client)
    created = (await client.post(f"/api/conversations/{convo['id']}/memories", json={
        "content": "Serana hates garlic.",
    })).json()
    assert created["source"] == "user"

    dupe = await client.post(f"/api/conversations/{convo['id']}/memories", json={
        "content": "Serana hates garlic.",
    })
    assert dupe.status_code == 400

    pinned = (await client.patch(f"/api/memories/{created['id']}", json={"is_pinned": True})).json()
    assert pinned["is_pinned"] is True

    deleted = await client.delete(f"/api/memories/{created['id']}")
    assert deleted.status_code == 204
    assert (await client.get(f"/api/conversations/{convo['id']}/memories")).json() == []


async def test_facts_budget_scales_with_context(client, fake_provider):
    """700-token budget was starving 16k-context chats; it now scales up."""
    from app.prompting.engine import build_chat_payload
    # 40 facts of ~30 tokens each ≈ 1200 tokens: over the old 700 floor,
    # under the scaled budget on a large context.
    memories = [{"content": "Fait " + "mot " * 25, "source_position": i, "is_pinned": False}
                for i in range(40)]
    # recent turn (100) so every fact's turn is outside the visible window
    recent = [{"role": "user", "variants": ["hi"], "active_index": 0, "position": 100}]
    small = build_chat_payload(
        character={"name": "X", "kind": "character"}, persona=None,
        conversation={"summary": ""}, messages=recent,
        connection={"context_size": 4096, "max_tokens": 512}, memories=memories,
    )
    big = build_chat_payload(
        character={"name": "X", "kind": "character"}, persona=None,
        conversation={"summary": ""}, messages=recent,
        connection={"context_size": 32768, "max_tokens": 1024}, memories=memories,
    )
    assert big.stats["facts_injected"] > small.stats["facts_injected"]
    assert big.stats["facts_total"] == 40


async def test_history_limit_setting_flows_into_chat(client, fake_provider):
    """PUT /api/settings history_limit must cap the turns the provider sees."""
    updated = (await client.put("/api/settings", json={"history_limit": 4})).json()
    assert updated["history_limit"] == 4

    convo = await setup_conversation(client)
    for _ in range(3):  # greeting + 3x(user+assistant) = 7 messages
        fake_provider.script = [ProviderEvent(type="delta", text="Reply."),
                                ProviderEvent(type="done")]
        await send(client, convo["id"], content="one more turn")
    payload = fake_provider.captured["payload"]
    assert len(payload.messages) == 4

    too_low = await client.put("/api/settings", json={"history_limit": 1})
    assert too_low.status_code == 422  # bounded: ge=4


async def test_consolidate_merges_facts(client, fake_provider):
    convo = await setup_conversation(client)
    for i in range(10):
        await client.post(f"/api/conversations/{convo['id']}/memories",
                          json={"content": f"Redundant fact number {i} about the same thing."})
    await client.post(f"/api/conversations/{convo['id']}/memories",
                      json={"content": "Crucial pinned fact.", "is_pinned": True})
    # user-added facts are source="user"; make them look auto so consolidation
    # moves them, with spread-out positions to check the merged stamp
    from app.db import _connect
    db = await _connect()
    await db.execute("UPDATE memories SET source='auto', source_position=30 WHERE is_pinned=0")
    await db.execute("UPDATE memories SET source_position=5 WHERE content LIKE '%number 3%'")
    await db.commit()
    await db.close()

    merged = json.dumps({"facts": [
        {"content": "Three facts merged into a single dense one."},
        {"content": "A second synthesized fact."},
    ]})
    fake_provider.script = [ProviderEvent(type="delta", text=merged), ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/consolidate")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["before"] == 11 and body["after"] == 3  # 2 merged + 1 pinned kept
    contents = {m["content"] for m in body["memories"]}
    assert "Crucial pinned fact." in contents  # pinned survived
    assert "Three facts merged into a single dense one." in contents
    # merged facts inherit the OLDEST source position (long-term memory must
    # not look recent, or the visible-window filter would mute it)
    merged_rows = [m for m in body["memories"] if m["source"] == "auto"]
    assert merged_rows and all(m["source_position"] == 5 for m in merged_rows)


async def test_consolidate_skips_when_few_facts(client, fake_provider):
    convo = await setup_conversation(client)
    await client.post(f"/api/conversations/{convo['id']}/memories", json={"content": "Un seul fait."})
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/consolidate")
    assert resp.status_code == 409
    assert resp.json()["kind"] == "too_few_facts"


MERGED = json.dumps({"facts": [{"content": "All of it, merged."}]})


async def add_facts(client, convo_id, contents, *, pinned=False, by_the_model=False):
    """Facts added by hand, which the model's own are told apart from."""
    from app.db import _connect

    for content in contents:
        await client.post(f"/api/conversations/{convo_id}/memories",
                          json={"content": content, "is_pinned": pinned})
    if by_the_model:
        db = await _connect()
        try:
            marks = ", ".join("?" for _ in contents)
            await db.execute(f"UPDATE memories SET source='auto' WHERE content IN ({marks})",
                             contents)
            await db.commit()
        finally:
            await db.close()


async def test_consolidation_prompt_holds_only_the_facts_it_may_merge(client, fake_provider):
    convo = await setup_conversation(client)
    movable = [f"Movable fact {i}." for i in range(8)]
    await add_facts(client, convo["id"], movable, by_the_model=True)
    # Pinned though the model wrote it, and unpinned though written by hand.
    await add_facts(client, convo["id"], ["Pinned fact."], pinned=True, by_the_model=True)
    await add_facts(client, convo["id"], ["Hand-written fact."])
    fake_provider.script = [ProviderEvent(type="delta", text=MERGED), ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo['id']}/memories/consolidate")

    assert resp.status_code == 200, resp.text
    content = fake_provider.captured["payload"].messages[0]["content"]
    assert content.startswith("FACTS TO CONSOLIDATE:\n- ")
    assert all(f"- {fact}" in content for fact in movable)
    assert "Pinned fact." not in content
    assert "Hand-written fact." not in content
    # Only what was merged is replaced: the pinned and the hand-written ones stay.
    body = resp.json()
    assert body["before"] == 10 and body["after"] == 3
    assert {m["content"] for m in body["memories"]} == {
        "Pinned fact.", "Hand-written fact.", "All of it, merged."}


async def consolidate_while(client, monkeypatch, convo_id, meanwhile):
    """Consolidate, running ``meanwhile`` (a coroutine function) as the model answers."""
    class Meanwhile(FakeProvider):
        async def stream_chat(self, payload):
            await meanwhile()
            async for event in super().stream_chat(payload):
                yield event

    monkeypatch.setattr("app.services.memory_service.get_provider", Meanwhile)
    FakeProvider.script = [ProviderEvent(type="delta", text=MERGED), ProviderEvent(type="done")]
    return await client.post(f"/api/conversations/{convo_id}/memories/consolidate")


@pytest.mark.parametrize("change", ["pinned", "edited", "deleted", "replaced"])
async def test_nothing_is_written_when_a_fact_sent_to_the_model_changed_meanwhile(
        client, fake_provider, monkeypatch, change):
    """The merge was written from all the facts that were sent: with one of them
    changed, its old text could come back inside a merged fact, so nothing is written."""
    from app.db import _connect

    convo = await setup_conversation(client)
    await add_facts(client, convo["id"], [f"Movable fact {i}." for i in range(8)],
                    by_the_model=True)
    before = await stored_facts(client, convo["id"])
    sent = {f["content"]: f["id"] for f in
            (await client.get(f"/api/conversations/{convo['id']}/memories")).json()}["Movable fact 3."]

    async def meanwhile():
        if change == "pinned":
            await client.patch(f"/api/memories/{sent}", json={"is_pinned": True})
        elif change == "edited":
            await client.patch(f"/api/memories/{sent}", json={"content": "Movable fact 3, edited."})
        elif change == "deleted":
            await client.delete(f"/api/memories/{sent}")
        else:
            # A fact of the same text, made since, is not the one that was sent.
            db = await _connect()
            await db.execute("UPDATE memories SET id = 'made-since' WHERE id = ?", (sent,))
            await db.commit()
            await db.close()

    resp = await consolidate_while(client, monkeypatch, convo["id"], meanwhile)

    assert resp.status_code == 409, resp.text
    assert resp.json()["kind"] == "facts_changed"

    def as_left(row):
        content, position, pinned, source = row
        if content != "Movable fact 3.":
            return row
        return {"pinned": (content, position, True, source),
                "edited": ("Movable fact 3, edited.", position, pinned, source),
                "deleted": None, "replaced": row}[change]

    assert await stored_facts(client, convo["id"]) == sorted(
        row for row in map(as_left, before) if row)


def waiting_provider(monkeypatch):
    """A provider for the memory passes that does not answer until ``release`` is set,
    and says when it was asked and with what."""
    started, release, asked = asyncio.Event(), asyncio.Event(), []

    class Waiting(FakeProvider):
        async def stream_chat(self, payload):
            asked.append(payload)
            started.set()
            await release.wait()
            async for event in super().stream_chat(payload):
                yield event

    monkeypatch.setattr("app.services.memory_service.get_provider", Waiting)
    return started, release, asked


async def within(seconds, awaitable):
    """So that a pass that waits for another fails the test instead of hanging it."""
    return await asyncio.wait_for(awaitable, seconds)


async def test_a_second_pass_while_a_consolidation_runs_changes_nothing_and_asks_nothing(
        client, fake_provider, monkeypatch):
    convo = await setup_conversation(client)
    await add_facts(client, convo["id"], [f"Movable fact {i}." for i in range(8)],
                    by_the_model=True)
    started, release, asked = waiting_provider(monkeypatch)
    FakeProvider.script = [ProviderEvent(type="delta", text=MERGED), ProviderEvent(type="done")]
    url = f"/api/conversations/{convo['id']}/memories"

    first = asyncio.create_task(client.post(f"{url}/consolidate"))
    try:
        await within(5, started.wait())
        second = await within(5, client.post(f"{url}/consolidate"))
        extraction = await within(5, client.post(f"{url}/extract"))
    finally:
        release.set()
    merged = await within(5, first)

    for refused in (second, extraction):
        assert refused.status_code == 409, refused.text
        assert refused.json()["kind"] == "memory_busy"
    assert len(asked) == 1
    assert merged.status_code == 200, merged.text
    assert merged.json()["before"] == 8 and merged.json()["after"] == 1
    assert [f[0] for f in await stored_facts(client, convo["id"])] == ["All of it, merged."]


class Raises(FakeProvider):
    async def stream_chat(self, payload):
        raise RuntimeError("the connection broke")
        yield  # pragma: no cover  (makes this a generator)


@pytest.mark.parametrize("failure", ["refused", "unreadable", "raised"])
async def test_a_consolidation_that_fails_lets_the_next_one_run(
        client, fake_provider, monkeypatch, failure):
    convo = await setup_conversation(client)
    await add_facts(client, convo["id"], [f"Movable fact {i}." for i in range(8)],
                    by_the_model=True)
    url = f"/api/conversations/{convo['id']}/memories/consolidate"

    if failure == "raised":
        monkeypatch.setattr("app.services.memory_service.get_provider", Raises)
        with pytest.raises(RuntimeError):
            await client.post(url)
    else:
        fake_provider.script = (
            [ProviderEvent(type="error", message="Quota exceeded.")] if failure == "refused"
            else [ProviderEvent(type="delta", text="no json here"), ProviderEvent(type="done")])
        assert (await client.post(url)).status_code == 502
    assert len(await stored_facts(client, convo["id"])) == 8

    monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
    fake_provider.script = [ProviderEvent(type="delta", text=MERGED), ProviderEvent(type="done")]
    resp = await client.post(url)

    assert resp.status_code == 200, resp.text
    assert [f[0] for f in await stored_facts(client, convo["id"])] == ["All of it, merged."]


async def test_a_merged_fact_that_repeats_a_fact_sent_leaves_that_fact_in_place(
        client, fake_provider):
    """Adding it again is refused as a double, so deleting the one sent would lose it."""
    convo = await setup_conversation(client)
    await add_facts(client, convo["id"], [f"Movable fact {i}." for i in range(8)],
                    by_the_model=True)
    merged = {"facts": [{"content": "Movable fact 3."}, {"content": "And more."}]}
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps(merged)),
                            ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo['id']}/memories/consolidate")

    assert resp.status_code == 200, resp.text
    assert resp.json()["before"] == 8 and resp.json()["after"] == 2
    assert [f[0] for f in await stored_facts(client, convo["id"])] == [
        "And more.", "Movable fact 3."]


async def test_extraction_prompt_holds_the_facts_the_turns_and_the_default_persona(
        client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="I broke the seal.")
    await client.patch(f"/api/conversations/{convo['id']}", json={"summary": "They met in a crypt."})
    await add_facts(client, convo["id"], ["Serana owes Alex a boot.", "The crypt is cold."])
    fake_provider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                            ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")

    assert resp.status_code == 200, resp.text
    payload = fake_provider.captured["payload"]
    content = payload.messages[0]["content"]
    assert "CURRENT SUMMARY:\nThey met in a crypt.\n\n" in content
    assert "- Serana owes Alex a boot." in content
    assert "- The crypt is cold." in content
    assert "(none yet)" not in content
    # The conversation has no persona of its own: the default one is the player.
    assert "Alex (turn 1): I broke the seal." in content
    assert "Serana (turn 2): *She smiles.* Hello." in content
    assert "between Alex (the player) and Serana" in payload.system


async def extract(client, convo_id, reply):
    FakeProvider.script = [ProviderEvent(type="delta", text=json.dumps(reply)),
                           ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo_id}/memories/extract")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def stored_facts(client, convo_id):
    """What the conversation remembers, as one comparable list."""
    rows = (await client.get(f"/api/conversations/{convo_id}/memories")).json()
    return sorted((m["content"], m["source_position"], m["is_pinned"], m["source"])
                  for m in rows)


async def test_a_messy_extraction_reply_leaves_the_facts_a_person_would_expect(
        client, fake_provider):
    """Spaces to strip, doubles, a fact the reply itself adds and then corrects, and the
    ones no reply may touch."""
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    top = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"][-1]["position"]
    await add_facts(client, convo["id"], ["Pinned fact."], pinned=True, by_the_model=True)
    await add_facts(client, convo["id"], ["Hand fact."])
    await add_facts(client, convo["id"], ["Old one.", "Old two.", "Old three.", "Old four."],
                    by_the_model=True)

    await extract(client, convo["id"], {
        "facts": [
            {"content": "  Fresh fact.  "},
            {"content": "Fresh fact."},  # the same, once stripped
            {"content": "Old one."},  # already known
            {"content": "   "},
            {"content": "Odd kind.", "kind": "Event"},  # what is not asked for is not read
            {"content": "Typed."},
            "a line, not a fact",
            {"kind": "event"},
        ],
        "updated_facts": [
            {"replaces": "  Old two.  ", "content": "  Old two, corrected.  "},
            {"replaces": "Pinned fact.", "content": "Overwritten."},  # pinned: left alone
            {"replaces": "Fresh fact.", "content": "Fresh fact, corrected."},  # added above
            {"replaces": "Typed.", "content": "Typed, again."},  # added above
            {"replaces": "Never said.", "content": "Said by an update."},  # nothing to replace
            {"replaces": "Hand fact.", "content": "Hand fact, corrected."},  # by hand: left alone
            {"replaces": "Old three.", "content": "Old one."},  # said already: dropped
            {"content": "Replaces nothing."},
            {"replaces": "Old three.", "content": "   "},
            ["not", "an", "update"],
        ],
        "obsolete_facts": ["Old four.", "Pinned fact.", "Hand fact.",
                           "  Fresh fact, corrected.  ", "Said by an update.", "Not known.", 3],
        "summary": "  A new summary.  ",
    })

    assert await stored_facts(client, convo["id"]) == sorted([
        ("Pinned fact.", 0, True, "auto"),
        ("Hand fact.", 0, False, "user"),
        ("Old one.", 0, False, "auto"),
        ("Old two, corrected.", 0, False, "auto"),
        ("Odd kind.", top, False, "auto"),
        ("Typed, again.", top, False, "auto"),
        ("Replaces nothing.", top, False, "auto"),
    ])
    assert (await client.get(f"/api/conversations/{convo['id']}")).json()["summary"] == "A new summary."


async def say_the_same(client, convo_id, other, same, positions):
    """A person edits the fact ``other`` into the text of ``same``: nothing refuses it,
    and the conversation then holds two facts of one text. ``positions`` are set
    first, by text, to tell the two apart."""
    from app.db import _connect

    db = await _connect()
    try:
        for content, position in positions.items():
            await db.execute("UPDATE memories SET source_position = ? WHERE content = ?",
                             (position, content))
        await db.commit()
    finally:
        await db.close()
    facts = (await client.get(f"/api/conversations/{convo_id}/memories")).json()
    target = next(f for f in facts if f["content"] == other)
    resp = await client.patch(f"/api/memories/{target['id']}", json={"content": same})
    assert resp.status_code == 200, resp.text


async def test_a_drop_never_reaches_a_hand_written_fact_that_an_edit_repeated(
        client, fake_provider):
    """The drop reaches the first fact that says the text, in the order of the list: here
    the model's, as it comes first by position."""
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    await add_facts(client, convo["id"], ["Same."])
    await add_facts(client, convo["id"], ["Other."], by_the_model=True)
    await say_the_same(client, convo["id"], "Other.", "Same.", {"Same.": 9, "Other.": 1})

    await extract(client, convo["id"], {"obsolete_facts": ["Same."]})

    assert await stored_facts(client, convo["id"]) == [("Same.", 9, False, "user")]


async def test_a_correction_never_rewrites_a_fact_that_a_person_wrote_or_pinned(
        client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    await add_facts(client, convo["id"], ["Hand fact."])
    await add_facts(client, convo["id"], ["Pinned fact."], pinned=True, by_the_model=True)
    await add_facts(client, convo["id"], ["Pinned by hand."], pinned=True)
    await add_facts(client, convo["id"], ["Old one."], by_the_model=True)

    await extract(client, convo["id"], {"updated_facts": [
        {"replaces": "Hand fact.", "content": "Rewritten."},
        {"replaces": "Pinned fact.", "content": "Rewritten too."},
        {"replaces": "Pinned by hand.", "content": "Rewritten as well."},
        {"replaces": "Old one.", "content": "Old one, corrected."}]})

    # Nothing is added in the place of a correction that is refused.
    assert await stored_facts(client, convo["id"]) == [
        ("Hand fact.", 0, False, "user"), ("Old one, corrected.", 0, False, "auto"),
        ("Pinned by hand.", 0, True, "user"), ("Pinned fact.", 0, True, "auto")]


async def test_a_fact_pinned_while_the_model_answers_is_left_alone(
        client, fake_provider, monkeypatch):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    await add_facts(client, convo["id"], ["Old one."], by_the_model=True)
    fact = (await client.get(f"/api/conversations/{convo['id']}/memories")).json()[0]

    class PinsWhileAnswering(FakeProvider):
        async def stream_chat(self, payload):
            await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": True})
            async for event in super().stream_chat(payload):
                yield event

    monkeypatch.setattr("app.services.memory_service.get_provider", PinsWhileAnswering)
    await extract(client, convo["id"], {
        "updated_facts": [{"replaces": "Old one.", "content": "Overwritten."}],
        "obsolete_facts": ["Old one."]})

    assert await stored_facts(client, convo["id"]) == [("Old one.", 0, True, "auto")]


async def test_embedding_stored_and_excluded_from_output(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import memories as mem_repo

    async def fake_embed(texts, kind):
        return [[0.5, 0.5]]  # non-None -> add() stores a blob

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    convo = await setup_conversation(client)
    created = (await client.post(f"/api/conversations/{convo['id']}/memories",
                                 json={"content": "A vectorized fact."})).json()
    assert "embedding" not in created  # bytes never leak into the API payload

    db = await _connect()
    try:
        emb_map = await mem_repo.list_embeddings(db, convo["id"])
        assert created["id"] in emb_map
        assert isinstance(emb_map[created["id"]], (bytes, memoryview))
    finally:
        await db.close()


async def test_the_task_of_the_start_gives_facts_and_messages_their_vectors(
        client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import conversations as convo_repo
    from app.repositories import memories as mem_repo

    async def no_embed(texts, kind):
        return None  # created as NULL

    monkeypatch.setattr(embeddings, "embed", no_embed)
    convo = await setup_conversation(client)  # and its greeting
    await client.post(f"/api/conversations/{convo['id']}/memories", json={"content": "A."})
    await client.post(f"/api/conversations/{convo['id']}/memories", json={"content": "B."})

    async def now_embed(texts, kind):
        return [[0.3, 0.4] for _ in texts]

    async def loaded():
        return True

    monkeypatch.setattr(embeddings, "embed", now_embed)
    monkeypatch.setattr(embeddings, "warmup", loaded)
    await memory_service.fill_vectors()

    db = await _connect()
    try:
        assert await mem_repo.list_missing_embeddings(db) == []
        assert await convo_repo.list_messages_missing_embeddings(db) == []
    finally:
        await db.close()


async def test_a_vector_is_not_stored_on_a_fact_rewritten_or_a_message_deleted_meanwhile(
        client, fake_provider):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import conversations as convo_repo
    from app.repositories import memories as mem_repo

    convo = await setup_conversation(client)  # and its greeting
    fact = (await client.post(f"/api/conversations/{convo['id']}/memories",
                              json={"content": "She keeps the key."})).json()
    greeting = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"][0]
    blob = embeddings.pack([1.0, 2.0])
    db = await _connect()
    try:
        await mem_repo.update(db, fact["id"], content="She lost the key.")
        assert await mem_repo.set_embedding(db, fact["id"], "She keeps the key.", blob) is False
        assert (await mem_repo.list_embeddings(db, convo["id"])).get(fact["id"]) != blob
        await convo_repo.delete_message(db, greeting["id"])
        assert await convo_repo.set_message_embedding(db, greeting["id"], blob) is False
    finally:
        await db.close()


async def test_chat_service_passes_relevance_scores(client, fake_provider, monkeypatch):
    """chat_service builds the scene, loads the embedding map, ranks the facts,
    and passes relevance_scores to the prompt builder."""
    import app.services.chat_service as cs
    from app.prompting import embeddings

    async def fake_embed(texts, kind):
        return [[1.0, 0.0] if "crypt" in t.lower() else [0.0, 1.0] for t in texts]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    await client.put("/api/settings", json={"auto_memory": False})  # no background facts
    convo = await setup_conversation(client)
    crypte = (await client.post(f"/api/conversations/{convo['id']}/memories",
                                json={"content": "The crypt seal was broken."})).json()
    meteo = (await client.post(f"/api/conversations/{convo['id']}/memories",
                               json={"content": "The weather was fine that day."})).json()
    # force both facts out of the visible window (anti-echo keeps them as candidates)
    from app.db import _connect
    db = await _connect()
    await db.execute("UPDATE memories SET source_position = 1")
    await db.commit()
    await db.close()

    captured = {}
    real = cs.build_chat_payload

    def spy(**kwargs):
        captured.update(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(cs, "build_chat_payload", spy)
    for _ in range(13):  # advance the window past the facts' position
        fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                                ProviderEvent(type="done")]
        await send(client, convo["id"], content="on avance")
    fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                            ProviderEvent(type="done")]
    await send(client, convo["id"], content="Tell me about the crypt.")

    scores = captured.get("relevance_scores")
    assert scores is not None
    assert scores[crypte["id"]] > scores[meteo["id"]]  # crypt-themed scene wins


async def test_update_content_refreshes_embedding(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import memories as mem_repo

    calls = {"n": 0}

    async def fake_embed(texts, kind):
        calls["n"] += 1
        return [[float(calls["n"]), 0.0]]  # distinct vector per call

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    convo = await setup_conversation(client)
    created = (await client.post(f"/api/conversations/{convo['id']}/memories",
                                 json={"content": "Version one."})).json()
    db = await _connect()
    try:
        before = (await mem_repo.list_embeddings(db, convo["id"]))[created["id"]]
    finally:
        await db.close()

    await client.patch(f"/api/memories/{created['id']}",
                       json={"content": "Version two, very different."})
    db = await _connect()
    try:
        after = (await mem_repo.list_embeddings(db, convo["id"]))[created["id"]]
    finally:
        await db.close()
    assert bytes(before) != bytes(after)  # vector refreshed to match new content


async def test_fork_copies_fact_embedding(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import memories as mem_repo

    async def fake_embed(texts, kind):
        return [[0.6, 0.8]]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="first turn")
    await client.post(f"/api/conversations/{convo['id']}/memories",
                      json={"content": "Fact to copy with vector."})  # source_position 0
    msgs = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    fork_at = msgs[1]  # position >= the fact's source_position (0)
    branch = (await client.post(f"/api/messages/{fork_at['id']}/branch")).json()

    db = await _connect()
    try:
        emb = await mem_repo.list_embeddings(db, branch["id"])
        assert len(emb) == 1  # copied fact carries its vector (not NULL)
    finally:
        await db.close()


async def test_passage_budget_setting(client, fake_provider):
    updated = (await client.put("/api/settings", json={"passage_budget": 800})).json()
    assert updated["passage_budget"] == 800
    fresh = (await client.get("/api/settings")).json()
    assert "passage_budget" in fresh
    too_big = await client.put("/api/settings", json={"passage_budget": 99999})
    assert too_big.status_code == 422  # bounded 0..4000


async def test_relevant_passage_retrieved_into_prompt(client, fake_provider, monkeypatch):
    """An old, out-of-window message that matches the current scene is injected
    verbatim under RELEVANT PAST."""
    from app.prompting import embeddings

    async def fake_embed(texts, kind):
        return [[1.0, 0.0] if "crypt" in t.lower() else [0.0, 1.0] for t in texts]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    await client.put("/api/settings", json={"auto_memory": False, "history_limit": 6,
                                            "passage_budget": 1500})
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="We sealed the crypt that night.")
    for _ in range(8):
        fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                                ProviderEvent(type="done")]
        await send(client, convo["id"], content="we talk about the weather")
    fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                            ProviderEvent(type="done")]
    await send(client, convo["id"], content="Tell me about the crypt again.")
    system = fake_provider.captured["payload"].system
    assert "### RELEVANT PAST" in system
    assert "crypt that night" in system  # the old message resurfaced verbatim


async def test_passages_off_when_budget_zero(client, fake_provider, monkeypatch):
    from app.prompting import embeddings

    async def fake_embed(texts, kind):
        return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    await client.put("/api/settings", json={"auto_memory": False, "history_limit": 6,
                                            "passage_budget": 0})
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="We sealed the crypt.")
    for _ in range(8):
        fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                                ProviderEvent(type="done")]
        await send(client, convo["id"], content="something else")
    fake_provider.script = [ProviderEvent(type="delta", text="ok"),
                            ProviderEvent(type="done")]
    await send(client, convo["id"], content="Tell me about the crypt again.")
    assert "### RELEVANT PAST" not in fake_provider.captured["payload"].system
