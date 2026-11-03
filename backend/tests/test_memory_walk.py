"""A walk through what a conversation remembers, on the real API and a real database: random
passes, corrections, drops, typed summaries, summaries asked for, consolidations, cuts,
forgotten and edited facts, pins, and branches of branches. Every message holds a token of
its own, so that what the memory says can be held against what is left of the story."""

import json
import random
import re
import uuid

import pytest

from app.db import _connect
from app.providers.base import ProviderEvent

from .test_chat import send, setup_conversation

SEEDS, STEPS = 4, 30
TABLES = {"conversations": "id", "messages": "conversation_id", "memories": "conversation_id",
          "memory_checkpoints": "conversation_id", "memory_checkpoint_facts": "conversation_id"}
STEP_KINDS = ["talk"] * 3 + ["pass"] * 3 + ["cut"] * 2 + [
    "one", "summarize", "type", "consolidate", "forget", "edit", "pin", "hand", "branch"]


def tokens(text):
    return set(re.findall(r"@(\w+)@", text or ""))


def say(found):
    return " ".join(f"@{t}@" for t in sorted(found))


def bullets(text):
    return re.findall(r"^- (.*)$", text, re.MULTILINE)


class World:
    """What the models need of a walk, and what it saw that excuses a fact being missing."""
    rng, count, looking, dropped, forgotten = None, 0, False, {}, set()

    @classmethod
    def token(cls, prefix):
        cls.count += 1
        return f"@{prefix}{cls.count}@"


class Answering:
    """A provider that says what ``answer`` returns."""
    def __init__(self, connection):
        pass

    async def stream_chat(self, payload):
        yield ProviderEvent(type="delta", text=self.answer(payload.messages))
        yield ProviderEvent(type="done")


class Story(Answering):
    def answer(self, messages):
        said = " ".join(m["content"] for m in messages)
        return f"GEN {say(tokens(said))}" if "[Write the summary" in said else f"reply {World.token('a')}"


class Memory(Answering):
    def answer(self, messages):
        text = messages[0]["content"]
        if text.startswith("FACTS TO CONSOLIDATE"):
            facts = bullets(text)
            return json.dumps({"facts": [{"content": f"merged {say(tokens(' '.join(facts[i:i + 3])))}"}
                                         for i in range(0, len(facts), 3)]})
        summary, rest = text.split("CURRENT SUMMARY:\n", 1)[1].split("\n\nFACTS ALREADY RECORDED:\n")
        known, turns = rest.split("\n\nNEWEST TURNS:\n")
        new = sorted(tokens(turns))
        answer = {"facts": [{"content": f"fact @{t}@"} for t in new if t not in tokens(known)],
                  "summary": f"S {say(tokens(summary) | set(new))}"}
        movable = [f for f in bullets(known) if f.startswith("fact @")]
        if not World.looking and new and movable:
            pick, roll = World.rng.choice(movable), World.rng.random()
            if roll < 0.3:  # corrected by a later turn: it now says something of that turn
                answer["updated_facts"] = [{"replaces": pick, "content": f"{pick} @{new[-1]}@"}]
            elif roll < 0.5:  # dropped because of a later turn
                answer["obsolete_facts"] = [pick]
                World.dropped.update(dict.fromkeys(tokens(pick), new[-1]))
            elif roll < 0.6:
                del answer["summary"]
        return json.dumps(answer)


@pytest.fixture()
def models(monkeypatch):
    monkeypatch.setattr("app.services.chat_service.get_provider", Story)
    monkeypatch.setattr("app.services.memory_service.get_provider", Memory)
    monkeypatch.setattr("app.services.memory_service.schedule_if_due", lambda convo_id: None)


async def read(client, cid):
    convo = (await client.get(f"/api/conversations/{cid}")).json()
    db = await _connect()
    try:
        checkpoints, copies = [[tuple(r) for r in await (await db.execute(
            f"SELECT * FROM {table} WHERE conversation_id = ? ORDER BY 2, 3", (cid,))).fetchall()]
            for table in ("memory_checkpoints", "memory_checkpoint_facts")]
    finally:
        await db.close()
    return {"convo": convo, "checkpoints": checkpoints, "copies": copies,
            "facts": (await client.get(f"/api/conversations/{cid}/memories")).json()}


async def facts_after_a_pass(client, cid):
    """On a copy made in SQL, so that looking does not change the walk and owes nothing to
    the code it looks at."""
    copy, db = uuid.uuid4().hex, await _connect()
    try:
        for table, key in TABLES.items():
            columns = [r["name"] for r in await (await db.execute(f"PRAGMA table_info({table})")).fetchall()]
            values = ["?" if c == key else "lower(hex(randomblob(16)))" if c == "id" else c for c in columns]
            await db.execute(f"INSERT INTO {table} ({', '.join(columns)}) SELECT {', '.join(values)}"
                             f" FROM {table} WHERE {key} = ?", (copy, cid))
        await db.commit()
    finally:
        await db.close()
    World.looking = True
    answered = await client.post(f"/api/conversations/{copy}/memories/extract")
    World.looking = False
    assert answered.status_code == 200, answered.text
    await client.delete(f"/api/conversations/{copy}")
    return answered.json()["memories"]


def the_models(fact):
    return not fact["is_pinned"] and fact["source"] == "auto"


async def check(client, cid, edited, forgotten_ids, stuck, trace):
    state = await read(client, cid)
    convo = state["convo"]
    alive = set().union(*(tokens(m["content"]) for m in convo["messages"]))
    last = max((m["position"] for m in convo["messages"]), default=0)
    assert convo["memory_position"] <= last, trace
    assert all(row[1] <= last for row in state["checkpoints"]), trace
    if not (convo["summary"] or "").startswith("TYPED"):
        assert tokens(convo["summary"]) <= alive, (convo["summary"], alive, trace)
    # A person kept it past the turns it speaks of. Unpinned, that would be their doing.
    stuck |= {f["content"] for f in state["facts"] if f["is_pinned"] and not tokens(f["content"]) <= alive}
    for fact in state["facts"]:
        if the_models(fact) and fact["id"] not in edited:
            assert tokens(fact["content"]) <= alive and fact["source_position"] <= last, (fact, trace)
        assert fact["id"] not in forgotten_ids, (fact, trace)
        assert fact["content"].startswith(edited.get(fact["id"], "")), (fact, "lost its edit", trace)
    assert not {row[2] for row in state["copies"]} & forgotten_ids, ("a copy kept a forgotten fact", trace)
    held = set().union(*(tokens(f["content"]) for f in await facts_after_a_pass(client, cid)))
    for token in alive - held - World.forgotten:
        assert World.dropped.get(token) in alive, (f"nothing remembers @{token}@", trace)


async def walk(client, seed):
    rng = World.rng = random.Random(seed)
    World.count, World.dropped, World.forgotten = 0, {}, set()
    await client.put("/api/settings", json={"auto_memory": False})
    cid = (await setup_conversation(client, greeting="Hello." if seed % 2 else ""))["id"]
    edited, forgotten_ids, stuck, trace = {}, set(), set(), []
    for _ in range(STEPS):
        state = await read(client, cid)
        convo, messages, facts = state["convo"], state["convo"]["messages"], state["facts"]
        base = f"/api/conversations/{cid}"
        unread = [m for m in messages if m["position"] > convo["memory_position"]]
        # A pass reads 40 turns at most: what it skips nothing remembers, cut or no cut.
        step = "pass" if len(unread) > 30 else rng.choice(STEP_KINDS)
        trace.append(step)
        if step == "talk":
            for _ in range(rng.randint(1, 3)):
                await send(client, cid, content=f"say {World.token('u')}")
        elif step in ("pass", "consolidate", "summarize"):
            url = {"pass": "memories/extract", "consolidate": "memories/consolidate", "summarize": "summarize"}
            answered = await client.post(f"{base}/{url[step]}")
            assert answered.status_code == 200 or not messages, answered.text
        elif step == "type":
            await client.patch(base, json={"summary": f"TYPED {World.token('t').strip('@')}"})
        elif step == "hand":
            await client.post(f"{base}/memories", json={"content": f"By hand {World.token('h').strip('@')}"})
        elif step in ("cut", "one") and messages:
            message = rng.choice(messages)
            # Kept past a cut, it stands at a position that says nothing of what was read.
            stuck |= {f["content"] for f in facts if f["is_pinned"] and f["source_position"] >= message["position"]}
            following = "?following=true" if step == "cut" else ""
            assert (await client.delete(f"/api/messages/{message['id']}{following}")).status_code == 204
            trace[-1] += f" {message['position']}"
            after = await read(client, cid)
            assert {f["id"] for f in facts if not the_models(f)} <= {f["id"] for f in after["facts"]}, trace
            if (convo["summary"] or "").startswith("TYPED"):
                assert after["convo"]["summary"] == convo["summary"], trace
        elif step == "branch" and messages:
            forked = await client.post(f"/api/messages/{rng.choice(messages)['id']}/branch")
            assert await read(client, cid) == state, ("a branch changed its source", trace)
            if rng.random() < 0.7:
                cid = forked.json()["id"]
        elif step in ("forget", "edit", "pin") and facts:
            fact = rng.choice(facts)
            if step == "forget":
                await client.delete(f"/api/memories/{fact['id']}")
                forgotten_ids.add(fact["id"])
                World.forgotten |= tokens(fact["content"])
            elif step == "edit":
                edited[fact["id"]] = f"{fact['content']} edited"
                await client.patch(f"/api/memories/{fact['id']}", json={"content": edited[fact["id"]]})
            elif fact["content"] not in stuck:
                await client.patch(f"/api/memories/{fact['id']}", json={"is_pinned": not fact["is_pinned"]})
        await check(client, cid, edited, forgotten_ids, stuck, trace)


@pytest.mark.parametrize("seed", range(SEEDS))
async def test_a_walk_through_the_memory_of_a_conversation(client, models, seed):
    await walk(client, seed)
