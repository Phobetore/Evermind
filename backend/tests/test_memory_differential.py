"""What plan_memory_changes decides from a list of facts is what applying the rules to
the database, one change at a time, makes. Duplicate-heavy states and messy answers,
from a fixed seed."""

import random

from app.db import _connect
from app.prompting.memory_changes import ALLOWED_KINDS, plan_memory_changes
from app.repositories import memories as repo
from app.services.memory_service import _apply

from .test_chat import setup_conversation

TEXTS = ["a", "b", "c", "d e", "f"]
BLANKS = ["", "", " ", "\t", "\xa0", "\x85", "\n"]
KINDS = [*sorted(ALLOWED_KINDS), "junk", ""]


def answer(rng):
    def text():
        return rng.choice(BLANKS) + rng.choice([*TEXTS, ""]) + rng.choice(BLANKS)

    def many(make):
        return [make() for _ in range(rng.randint(0, 5))]

    return {"facts": many(lambda: {"content": text(), "kind": rng.choice(KINDS)}),
            "updated_facts": many(lambda: {"replaces": text(), "content": text()}),
            "obsolete_facts": many(text)}


async def seed(db, convo_id, rng):
    for i in range(rng.randint(0, 7)):
        await db.execute(
            "INSERT INTO memories (id, conversation_id, kind, content, source_position,"
            " is_pinned, source, created_at) VALUES (?, ?, 'fact', ?, ?, ?, ?, ?)",
            (f"{convo_id}-{i}", convo_id, rng.choice(TEXTS), rng.randint(0, 5),
             int(rng.random() < 0.25), rng.choice(["auto", "auto", "user"]),
             f"2026-01-01T00:00:0{rng.randint(0, 3)}+00:00"))
    await db.commit()


async def by_the_rules(db, convo_id, reply, top):
    """The rules, applied to the database as each change comes."""
    for fact in reply["facts"]:
        await repo.add(db, convo_id, fact["content"], fact["kind"], top, source="auto")
    for update in reply["updated_facts"]:
        new = update["content"].strip()
        target = await repo.find_by_content(db, convo_id, update["replaces"])
        if not new:
            continue
        if target is None:
            await repo.add(db, convo_id, new, source_position=top, source="auto")
        elif target["is_pinned"] or target["source"] != "auto":
            continue
        elif await (await db.execute(
                "SELECT 1 FROM memories WHERE conversation_id = ? AND content = ? AND id != ?",
                (convo_id, new, target["id"]))).fetchone():
            await repo.delete(db, target["id"])
        else:
            await repo.update(db, target["id"], content=new)
    for text in reply["obsolete_facts"]:
        target = await repo.find_by_content(db, convo_id, text)
        if target and not target["is_pinned"] and target["source"] == "auto":
            await repo.delete(db, target["id"])


async def stored(db, convo_id):
    return sorted((m["content"], m["kind"], m["source_position"], m["is_pinned"], m["source"])
                  for m in await repo.list_for_conversation(db, convo_id))


async def test_the_changes_decided_from_a_list_are_the_ones_made_one_by_one(client):
    ruled = await setup_conversation(client)
    planned = (await client.post("/api/conversations", json={"character_id": ruled["character_id"]})).json()
    db = await _connect()
    try:
        for n in range(200):
            await db.execute("DELETE FROM memories")
            await seed(db, ruled["id"], random.Random(n))
            await seed(db, planned["id"], random.Random(n))
            reply = answer(random.Random(1000 + n))

            await by_the_rules(db, ruled["id"], reply, n)
            changes = plan_memory_changes(reply, await repo.list_in_lookup_order(db, planned["id"]), n)
            await _apply(db, planned["id"], changes["ops"], {})
            await db.commit()

            assert await stored(db, ruled["id"]) == await stored(db, planned["id"]), (n, reply)
    finally:
        await db.close()
