"""The reply is written while it streams, not only once it is finished.

A server that goes down leaves a turn anywhere, and nothing afterwards gets to save what had
arrived: writing as it goes means whatever arrived is already kept, marked as cut short until
the last write says it is whole.
"""

import asyncio
import json
import shutil
import sqlite3
from contextlib import closing

import pytest

from app import db
from app.config import db_path
from app.models.schemas import ChatRequest
from app.providers.base import ProviderEvent
from app.services import turns
from tests.conftest import messages_of, setup_conversation


class HeldBack:
    """Five words, then nothing more until the test lets it go."""

    let_go: asyncio.Event

    def __init__(self, connection):
        self.connection = connection

    async def stream_chat(self, payload):
        for i in range(5):
            yield ProviderEvent(type="delta", text=f"mot{i} ")
        await HeldBack.let_go.wait()
        yield ProviderEvent(type="delta", text="fin")
        yield ProviderEvent(type="done")


@pytest.fixture()
def held_back(monkeypatch):
    HeldBack.let_go = asyncio.Event()
    monkeypatch.setattr("app.services.chat_service.get_provider", HeldBack)
    monkeypatch.setattr("app.services.chat_service._FLUSH_SECONDS", 0)


async def test_a_server_going_down_keeps_every_word_written_and_says_it_was_cut_short(
        client, held_back):
    convo = await setup_conversation(client)
    turn = await turns.start(ChatRequest(conversation_id=convo["id"], mode="send", content="Coupe-moi"))

    async def written():
        while "mot4" not in (await messages_of(client, convo["id"]))[-1]["content"]:
            await asyncio.sleep(0.01)

    await asyncio.wait_for(written(), timeout=10)
    turn.task.cancel()  # what a server shutting down does to it
    await asyncio.wait_for(turn.finished.wait(), timeout=5)

    reply = (await messages_of(client, convo["id"]))[-1]
    assert reply["role"] == "assistant"
    assert reply["content"] == "mot0 mot1 mot2 mot3 mot4"
    assert reply["meta"] == {"interrupted": [0]}
    assert await turns.running_for(convo["id"]) is None


async def test_a_reply_says_it_is_unfinished_until_it_is_whole(client, held_back):
    convo = await setup_conversation(client)
    turn = await turns.start(ChatRequest(conversation_id=convo["id"], mode="send", content="Ecris-moi"))

    async def cut_short():
        while (await messages_of(client, convo["id"]))[-1]["meta"].get("interrupted") != [0]:
            await asyncio.sleep(0.01)

    await asyncio.wait_for(cut_short(), timeout=10)
    HeldBack.let_go.set()
    await asyncio.wait_for(turn.finished.wait(), timeout=10)

    messages = await messages_of(client, convo["id"])
    assert [m["role"] for m in messages] == ["assistant", "user", "assistant"], "a write added a message"
    assert messages[-1]["content"] == "mot0 mot1 mot2 mot3 mot4 fin"
    assert "interrupted" not in messages[-1]["meta"]


async def test_a_reply_3_0_x_marked_is_cut_on_its_first_version(tmp_path, monkeypatch):
    """3.0.x marked a reply only while it had a single version, so one regenerated since, which shows
    its whole second version, was cut on its first."""
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "data"))
    every, released = db.MIGRATIONS_DIR, tmp_path / "released"
    released.mkdir()
    for path in every.glob("*.sql"):
        if path.name < "016":
            shutil.copy(path, released / path.name)
    monkeypatch.setattr(db, "MIGRATIONS_DIR", released)
    await db.init_db()
    with closing(sqlite3.connect(db_path())) as conn, conn:
        conn.executescript("""
            INSERT INTO characters (id, name, created_at, updated_at) VALUES ('c', 'C', '', '');
            INSERT INTO conversations (id, character_id, created_at, updated_at) VALUES ('v', 'c', '', '');
            INSERT INTO messages (id, conversation_id, role, variants, active_index, position, meta,
                                  created_at) VALUES
              ('regenerated', 'v', 'assistant', '["cut", "whole"]', 1, 0, '{"interrupted": true}', ''),
              ('left', 'v', 'assistant', '["cut"]', 0, 1, '{"streaming": true}', '');
        """)

    monkeypatch.setattr(db, "MIGRATIONS_DIR", every)
    await db.init_db()

    with closing(sqlite3.connect(db_path())) as conn:
        marks = dict(conn.execute("SELECT id, meta FROM messages").fetchall())
    assert json.loads(marks["regenerated"]) == {"interrupted": [0]}, "the whole version is marked"
    assert json.loads(marks["left"]) == {"interrupted": [0]}
