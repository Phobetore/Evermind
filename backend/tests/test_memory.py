"""Memory system tests: extraction, dedup, scheduling, injection, endpoints."""

import json

import pytest

from app.providers.base import ProviderEvent
from app.services import memory_service

from .test_chat import FakeProvider, send, setup_conversation

EXTRACTION_JSON = json.dumps({
    "facts": [
        {"content": "Aymeric broke the crypt seal.", "kind": "event"},
        {"content": "Serana distrusts Aymeric.", "kind": "relationship"},
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


async def test_facts_injected_into_chat_payload(client, fake_provider):
    convo = await setup_conversation(client)
    await client.post(f"/api/conversations/{convo['id']}/memories", json={
        "content": "Aymeric killed Serana's parents before her eyes.",
        "kind": "event", "is_pinned": True,
    })
    await send(client, convo["id"])
    payload = fake_provider.captured["payload"]
    assert "### ESTABLISHED FACTS" in payload.system
    assert "killed Serana's parents" in payload.system


async def test_memory_crud(client, fake_provider):
    convo = await setup_conversation(client)
    created = (await client.post(f"/api/conversations/{convo['id']}/memories", json={
        "content": "Serana hates garlic.", "kind": "fact",
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
        {"content": "Three facts merged into a single dense one.", "kind": "fact"},
        {"content": "A second synthesized fact.", "kind": "event"},
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
    assert resp.status_code == 200
    assert resp.json().get("skipped") == "too_few"


MERGED = json.dumps({"facts": [{"content": "All of it, merged.", "kind": "fact"}]})


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


async def test_consolidation_names_the_player_as_a_chat_turn_does(client, fake_provider):
    """The conversation has no persona of its own: the default one is the player."""
    convo = await setup_conversation(client)
    await add_facts(client, convo["id"], [f"Movable fact {i}." for i in range(8)],
                    by_the_model=True)
    fake_provider.script = [ProviderEvent(type="delta", text=MERGED), ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo['id']}/memories/consolidate")

    assert resp.status_code == 200, resp.text
    assert "between Alex and Serana" in fake_provider.captured["payload"].system


@pytest.mark.parametrize(("movable", "merged"), [(7, False), (8, True)])
async def test_consolidation_starts_at_eight_movable_facts(client, fake_provider, movable, merged):
    convo = await setup_conversation(client)
    await add_facts(client, convo["id"], [f"Movable fact {i}." for i in range(movable)],
                    by_the_model=True)
    # Two more that it may not merge, so that counting every fact would reach eight.
    await add_facts(client, convo["id"], ["Pinned fact."], pinned=True)
    await add_facts(client, convo["id"], ["Hand-written fact."])
    fake_provider.script = [ProviderEvent(type="delta", text=MERGED), ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo['id']}/memories/consolidate")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    if merged:
        assert "skipped" not in body
        assert "payload" in fake_provider.captured
    else:
        assert body["skipped"] == "too_few"
        assert body["before"] == body["after"] == movable + 2
        assert fake_provider.captured == {}  # the model was not asked


async def test_consolidation_keeps_only_facts_that_are_text_and_at_most_thirty(
        client, fake_provider):
    convo = await setup_conversation(client)
    await add_facts(client, convo["id"], [f"Movable fact {i}." for i in range(8)],
                    by_the_model=True)
    merged = [{"content": ["a"]}, {"content": 12}, {"content": "   "}, "text", {"kind": "event"},
              {"content": "  Padded.  ", "kind": "Event"}]
    merged += [{"content": f"Merged {i}.", "kind": "promise"} for i in range(40)]
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps({"facts": merged})),
                            ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo['id']}/memories/consolidate")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Thirty of the readable ones: the padded one, stripped and made a fact, and the
    # first 29 after it, with the kind they were given.
    assert body["after"] == 30
    kinds = {m["content"]: m["kind"] for m in body["memories"]}
    assert kinds == {"Padded.": "fact", **{f"Merged {i}.": "promise" for i in range(29)}}


async def test_consolidation_with_no_fact_that_is_text_changes_nothing(client, fake_provider):
    convo = await setup_conversation(client)
    await add_facts(client, convo["id"], [f"Movable fact {i}." for i in range(8)],
                    by_the_model=True)
    fake_provider.script = [
        ProviderEvent(type="delta", text=json.dumps({"facts": [{"content": ["a"]}, {"content": 12}]})),
        ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo['id']}/memories/consolidate")

    assert resp.status_code == 502
    assert resp.json()["kind"] == "model_unreadable"
    assert len((await client.get(f"/api/conversations/{convo['id']}/memories")).json()) == 8


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


async def test_extraction_asks_the_model_nothing_when_no_turn_is_new(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    fake_provider.script = [ProviderEvent(type="delta", text=EXTRACTION_JSON),
                            ProviderEvent(type="done")]
    await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert "payload" in fake_provider.captured
    fake_provider.captured.clear()

    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")

    assert resp.status_code == 200, resp.text
    assert resp.json()["facts_added"] == []
    assert fake_provider.captured == {}


async def extract(client, convo_id, reply):
    FakeProvider.script = [ProviderEvent(type="delta", text=json.dumps(reply)),
                           ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo_id}/memories/extract")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def stored_facts(client, convo_id):
    """What the conversation remembers, as one comparable list."""
    rows = (await client.get(f"/api/conversations/{convo_id}/memories")).json()
    return sorted((m["content"], m["kind"], m["source_position"], m["is_pinned"], m["source"])
                  for m in rows)


async def test_a_messy_extraction_reply_leaves_the_facts_a_person_would_expect(
        client, fake_provider):
    """Spaces to strip, doubles, an unknown kind, a fact the reply itself adds and
    then corrects, and the ones no reply may touch."""
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    top = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"][-1]["position"]
    await add_facts(client, convo["id"], ["Pinned fact."], pinned=True, by_the_model=True)
    await add_facts(client, convo["id"], ["Hand fact."])
    await add_facts(client, convo["id"], ["Old one.", "Old two.", "Old three.", "Old four."],
                    by_the_model=True)

    await extract(client, convo["id"], {
        "facts": [
            {"content": "  Fresh fact.  ", "kind": "event"},
            {"content": "Fresh fact.", "kind": "promise"},  # the same, once stripped
            {"content": "Old one.", "kind": "promise"},  # already known
            {"content": "   ", "kind": "event"},
            {"content": "Odd kind.", "kind": "Event"},  # not one of the kinds
            {"content": "Typed.", "kind": "state"},
            "a line, not a fact",
            {"kind": "event"},
        ],
        "updated_facts": [
            {"replaces": "  Old two.  ", "content": "  Old two, corrected.  "},
            {"replaces": "Pinned fact.", "content": "Overwritten."},  # pinned: left alone
            {"replaces": "Fresh fact.", "content": "Fresh fact, corrected."},  # added above
            {"replaces": "Typed.", "content": "Typed, again."},  # added above
            {"replaces": "Never said.", "content": "Said by an update."},  # nothing to replace
            {"replaces": "Hand fact.", "content": "Hand fact, corrected."},
            {"content": "Replaces nothing."},
            {"replaces": "Old three.", "content": "   "},
            ["not", "an", "update"],
        ],
        "obsolete_facts": ["Old four.", "Pinned fact.", "Hand fact, corrected.",
                           "  Fresh fact, corrected.  ", "Said by an update.", "Not known.", 3],
        "summary": "  A new summary.  ",
    })

    assert await stored_facts(client, convo["id"]) == sorted([
        ("Pinned fact.", "fact", 0, True, "auto"),
        ("Hand fact, corrected.", "fact", 0, False, "user"),
        ("Old one.", "fact", 0, False, "auto"),
        ("Old two, corrected.", "fact", 0, False, "auto"),
        ("Old three.", "fact", 0, False, "auto"),
        ("Odd kind.", "fact", top, False, "auto"),
        ("Typed, again.", "state", top, False, "auto"),
        ("Replaces nothing.", "fact", top, False, "auto"),
    ])
    assert (await client.get(f"/api/conversations/{convo['id']}")).json()["summary"] == "A new summary."


async def test_a_drop_reaches_the_oldest_of_two_facts_that_say_the_same(client, fake_provider):
    """Correcting a fact into what another says is not refused: the text then
    names two facts, and a drop of it reaches the oldest."""
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    await add_facts(client, convo["id"], ["Same.", "Other."], by_the_model=True)
    from app.db import _connect
    db = await _connect()
    await db.execute("UPDATE memories SET source_position = CASE content WHEN 'Same.' THEN 3"
                     " ELSE 4 END")
    await db.commit()
    await db.close()

    await extract(client, convo["id"], {
        "updated_facts": [{"replaces": "Other.", "content": "Same."}],
        "obsolete_facts": ["Same."]})

    assert await stored_facts(client, convo["id"]) == [("Same.", "fact", 4, False, "auto")]


async def test_a_drop_reaches_a_pinned_fact_before_another_that_says_the_same(
        client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    await add_facts(client, convo["id"], ["Pinned."], pinned=True, by_the_model=True)
    await add_facts(client, convo["id"], ["Other."], by_the_model=True)

    await extract(client, convo["id"], {
        "updated_facts": [{"replaces": "Other.", "content": "Pinned."}],
        "obsolete_facts": ["Pinned."]})

    # The pinned one is the one found, and a pinned fact is not dropped.
    assert await stored_facts(client, convo["id"]) == [
        ("Pinned.", "fact", 0, False, "auto"), ("Pinned.", "fact", 0, True, "auto")]


async def test_a_drop_never_reaches_a_hand_written_fact_that_a_correction_repeated(
        client, fake_provider):
    """The drop is applied by the text, so plan_memory_changes must choose the fact
    that the repository will: here the older one, written by hand, though the other
    comes first by position."""
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    await add_facts(client, convo["id"], ["Same."])
    await add_facts(client, convo["id"], ["Other."], by_the_model=True)
    from app.db import _connect
    db = await _connect()
    await db.execute("UPDATE memories SET source_position = CASE content WHEN 'Same.' THEN 9"
                     " ELSE 1 END")
    await db.commit()
    await db.close()

    await extract(client, convo["id"], {
        "updated_facts": [{"replaces": "Other.", "content": "Same."}],
        "obsolete_facts": ["Same."]})

    assert await stored_facts(client, convo["id"]) == [
        ("Same.", "fact", 1, False, "auto"), ("Same.", "fact", 9, False, "user")]


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

    assert await stored_facts(client, convo["id"]) == [("Old one.", "fact", 0, True, "auto")]


async def test_a_change_to_a_fact_that_is_gone_is_left_alone(client, fake_provider):
    from app.db import _connect

    convo = await setup_conversation(client)
    await add_facts(client, convo["id"], ["Here."])
    db = await _connect()
    try:
        added = await memory_service._apply(db, convo["id"], [
            {"op": "update", "target": "Gone.", "content": "Back."},
            {"op": "delete", "target": "Gone."},
            {"op": "update", "target": "Here.", "content": "Here, corrected."},
        ])
    finally:
        await db.close()

    assert added == []
    assert [f[0] for f in await stored_facts(client, convo["id"])] == ["Here, corrected."]


async def test_only_text_counts_as_text_in_an_extraction_reply(client, fake_provider):
    """A number or a list is not a fact: ``str()`` of it used to be stored as one."""
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    await add_facts(client, convo["id"], ["Old one."], by_the_model=True)

    body = await extract(client, convo["id"], {
        "facts": [{"content": ["a"]}, {"content": 12}, {"content": None}, {"content": True},
                  {"content": "Real fact.", "kind": ["event"]}],
        "updated_facts": [{"replaces": ["Old one."], "content": {"a": 1}},
                          {"replaces": 5, "content": "Kept by no one.", "kind": 3}],
        "obsolete_facts": [["Old one."], None, 0, False],
        "summary": ["A summary."],
    })

    assert [m["content"] for m in body["facts_added"]] == ["Real fact.", "Kept by no one."]
    assert {m["content"] for m in (
        await client.get(f"/api/conversations/{convo['id']}/memories")).json()} == {
        "Old one.", "Real fact.", "Kept by no one."}
    assert body["summary"] == ""


async def test_what_is_not_a_list_in_an_extraction_reply_holds_nothing(client, fake_provider):
    """A string is not a list of letters, and a number is not a list: neither
    gives a fact nor fails the extraction."""
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    await add_facts(client, convo["id"], ["a", "b"], by_the_model=True)

    body = await extract(client, convo["id"], {
        "facts": "abc", "updated_facts": 5, "obsolete_facts": "ab", "summary": 7})

    assert body["facts_added"] == []
    assert {m["content"] for m in (
        await client.get(f"/api/conversations/{convo['id']}/memories")).json()} == {"a", "b"}


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


async def test_list_missing_and_set_embedding(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import memories as mem_repo

    async def no_embed(texts, kind):
        return None  # model not ready -> stored as NULL

    monkeypatch.setattr(embeddings, "embed", no_embed)
    convo = await setup_conversation(client)
    created = (await client.post(f"/api/conversations/{convo['id']}/memories",
                                 json={"content": "Fact without a vector."})).json()

    db = await _connect()
    try:
        missing = await mem_repo.list_missing_embeddings(db)
        assert any(m["id"] == created["id"] for m in missing)
        await mem_repo.set_embedding(db, created["id"], embeddings.pack([0.1, 0.2]))
        missing_after = await mem_repo.list_missing_embeddings(db)
        assert all(m["id"] != created["id"] for m in missing_after)
    finally:
        await db.close()


async def test_backfill_embeddings_fills_missing(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import memories as mem_repo
    from app.services import memory_service

    async def no_embed(texts, kind):
        return None  # created as NULL

    monkeypatch.setattr(embeddings, "embed", no_embed)
    convo = await setup_conversation(client)
    await client.post(f"/api/conversations/{convo['id']}/memories", json={"content": "A."})
    await client.post(f"/api/conversations/{convo['id']}/memories", json={"content": "B."})

    async def now_embed(texts, kind):
        return [[0.3, 0.4] for _ in texts]

    monkeypatch.setattr(embeddings, "embed", now_embed)
    db = await _connect()
    try:
        filled = await memory_service.backfill_embeddings(db)
        assert filled == 2
        assert await mem_repo.list_missing_embeddings(db) == []
    finally:
        await db.close()


async def test_backfill_noop_without_model(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.services import memory_service

    async def no_embed(texts, kind):
        return None

    monkeypatch.setattr(embeddings, "embed", no_embed)
    convo = await setup_conversation(client)
    await client.post(f"/api/conversations/{convo['id']}/memories", json={"content": "A."})
    db = await _connect()
    try:
        filled = await memory_service.backfill_embeddings(db)
        assert filled == 0  # nothing embedded, no crash
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


async def test_update_content_nulls_embedding_without_model(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import memories as mem_repo

    async def has_embed(texts, kind):
        return [[0.5, 0.5]]

    monkeypatch.setattr(embeddings, "embed", has_embed)
    convo = await setup_conversation(client)
    created = (await client.post(f"/api/conversations/{convo['id']}/memories",
                                 json={"content": "With vector."})).json()

    async def no_embed(texts, kind):
        return None

    monkeypatch.setattr(embeddings, "embed", no_embed)
    await client.patch(f"/api/memories/{created['id']}", json={"content": "Modified text."})
    db = await _connect()
    try:
        missing = await mem_repo.list_missing_embeddings(db)
        assert any(m["id"] == created["id"] for m in missing)  # NULLed for backfill
    finally:
        await db.close()


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


async def test_backfill_message_embeddings_fills_missing(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.repositories import conversations as convo_repo
    from app.services import memory_service

    async def now_embed(texts, kind):
        return [[0.3, 0.4] for _ in texts]

    monkeypatch.setattr(embeddings, "embed", now_embed)
    await setup_conversation(client)  # seeds a greeting message
    db = await _connect()
    try:
        filled = await memory_service.backfill_message_embeddings(db)
        assert filled >= 1
        assert await convo_repo.list_messages_missing_embeddings(db) == []
    finally:
        await db.close()


async def test_backfill_messages_noop_without_model(client, fake_provider, monkeypatch):
    from app.db import _connect
    from app.prompting import embeddings
    from app.services import memory_service

    async def no_embed(texts, kind):
        return None

    monkeypatch.setattr(embeddings, "embed", no_embed)
    await setup_conversation(client)
    db = await _connect()
    try:
        filled = await memory_service.backfill_message_embeddings(db)
        assert filled == 0
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
