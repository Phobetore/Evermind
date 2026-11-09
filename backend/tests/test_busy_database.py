"""What a person saves waits for a write that holds the database, rather than failing."""

import asyncio

import aiosqlite

from app import db
from app.providers.base import ProviderEvent
from app.services import turns

from .conftest import FakeProvider, messages_of, setup_conversation


async def test_an_edit_a_send_and_a_setting_wait_for_a_write_held_past_five_seconds(
        client, monkeypatch):
    FakeProvider.script = [ProviderEvent(type="delta", text="She nods."),
                           ProviderEvent(type="done")]
    monkeypatch.setattr("app.services.chat_service.get_provider", FakeProvider)
    convo = await setup_conversation(client)
    holder = await db.connect()
    try:
        # What a reply being saved or a memory pass does, on a computer too busy to be quick.
        await holder.execute("BEGIN IMMEDIATE")
        asked = [asyncio.create_task(call) for call in (
            client.patch(f"/api/conversations/{convo['id']}", json={"author_note": "Rain."}),
            client.post("/api/chat", json={"conversation_id": convo["id"], "mode": "send",
                                           "content": "Hello"}),
            client.put("/api/settings", json={"reply_length": "long"}),
        )]
        await asyncio.sleep(6)  # past the 5 seconds SQLite waits unless told otherwise
        assert not any(task.done() for task in asked)
        await holder.commit()
        answers = await asyncio.gather(*asked)
    finally:
        await holder.close()

    assert [answer.status_code for answer in answers] == [200, 200, 200]
    turn = await turns.running_for(convo["id"])
    if turn:
        await turn.finished.wait()
    read = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert read["author_note"] == "Rain."
    assert [m["content"] for m in await messages_of(client, convo["id"])][1:] == [
        "Hello", "She nods."]
    assert (await client.get("/api/settings")).json()["reply_length"] == "long"


async def test_a_connection_commits_while_what_opening_it_returned_is_still_held(
        tmp_path, monkeypatch):
    """Kept as a debugger keeps a frame's: a statement left running would fail the commit."""
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path))
    await db.init_db()
    held, run = [], aiosqlite.Connection._execute

    async def holding(self, fn, *args, **kwargs):
        held.append(result := await run(self, fn, *args, **kwargs))
        return result

    monkeypatch.setattr(aiosqlite.Connection, "_execute", holding)
    conn = await db.connect()
    try:
        await conn.execute("INSERT INTO settings (key, value) VALUES ('reply_length', '\"long\"')")
        await conn.commit()
    finally:
        await conn.close()
