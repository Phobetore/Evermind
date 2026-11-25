"""The requests each AI sent in 3.7.0, kept in fixtures/requests_3_7.json so that the update to
the ways of playing can be shown to send every model the same ones.

The seed is the one of requests_before.json, brought to 3.7.0 (every migration up to 021 run on
it, then the rest of them), in three variants of the three settings that were the way of playing,
written by SQL before the update: ``untouched`` (no row) and ``touched`` (reply_length "long",
history_limit 4, passage_budget 3000, as settings_repo.put writes them). The third, ``recalling``,
is ``touched`` with what the first two never meet: an embedder, so that retrieval returns
passages, a first message long enough to fit the passage budget of 3000 and not the 1500 it was
before, and four AIs the update before set to ``auto``, so that the reply room reaches the
request. For each, the four calls of every connection and the turn's meta.context, as
test_requests_before holds them.

It is recorded, never written by hand, on the code of 3.7.0 (the base of the ways of playing):
``python -m tests.test_requests_3_7 --record`` from backend/ of that code. Later tasks add the
exceptions the plan names to same_request and same_context, one by one, each checked on its own.
"""

import asyncio
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

import httpx
import numpy as np

from app import db
from app.config import db_path
from app.prompting import embeddings
from app.services.ai_call import margin_for

from .test_requests_before import (
    CALLS,
    Server,
    call_each,
    lent_to_every_provider,
    put_seed,
    without_usage_asked,
)
from .test_requests_before import RECORDED as BEFORE

RECORDED = Path(__file__).resolve().parent / "fixtures" / "requests_3_7.json"
MIGRATION = "021_my_ais.sql"

# The settings the release before kept as the way of playing, written as settings_repo.put does.
TOUCHED = {"reply_length": "long", "history_limit": 4, "passage_budget": 3000}
VARIANTS = {
    "untouched": {},
    "touched": TOUCHED,
    "recalling": TOUCHED,
}
# About 2000 tokens as the engine counts: a passage that fits a budget of 3000, not of 1500.
LONG_FIRST_MESSAGE = "*The carvings are long and old.* " * 210
# AIs whose reply room is the way's: the AIs of 3.7.0 that Evermind sets (the seed's own were
# fixed or unsent when the connections became AIs).
AUTO = ("c-ollama", "c-openai", "c-anthropic-unset", "c-openrouter")


class Embedder:
    """Every text lands on the same vector: retrieval returns whatever fits the budget."""

    def encode(self, texts, normalize_embeddings=False):
        return np.array([[1.0, 0.0] for _ in texts], dtype=np.float32)


@contextmanager
def embedding(variant: str):
    was = embeddings._model
    if variant == "recalling":
        embeddings._model = Embedder()
    try:
        yield
    finally:
        embeddings._model = was


async def sent_in(variant: str, folder: Path) -> dict:
    """The seed of 3.6.0 brought to the code this runs on with ``variant``'s settings, and every
    call of every connection: {connection: {call: body, ..., "turn_context": ...}}."""
    seed = json.loads(BEFORE.read_text(encoding="utf-8"))["seed"]
    real = db.MIGRATIONS_DIR
    migrations = folder / "migrations"
    migrations.mkdir()
    for path in real.glob("*.sql"):
        if path.name < MIGRATION:
            shutil.copy(path, migrations / path.name)
    was = os.environ.get("EVERMIND_DATA_DIR")
    os.environ["EVERMIND_DATA_DIR"] = str(folder / "data")
    db.MIGRATIONS_DIR = migrations
    try:
        await db.init_db()
        conn = sqlite3.connect(db_path())
        try:
            put_seed(conn, seed)
            for key, value in VARIANTS[variant].items():
                conn.execute("INSERT INTO settings (key, value) VALUES (?, ?)",
                             (key, json.dumps(value)))
            if variant == "recalling":
                conn.execute("UPDATE messages SET variants = ? WHERE position = 0",
                             (json.dumps([LONG_FIRST_MESSAGE]),))
            conn.commit()
        finally:
            conn.close()
        for path in real.glob("*.sql"):
            shutil.copy(path, migrations / path.name)

        from app.main import create_app

        app = create_app()
        await db.init_db()  # the update
        if variant == "recalling":
            conn = sqlite3.connect(db_path())
            try:
                conn.execute("UPDATE models SET reply_cap_mode = 'auto', reply_cap_tokens = NULL"
                             f" WHERE id IN ({', '.join('?' for _ in AUTO)})", AUTO)
                conn.commit()
            finally:
                conn.close()
        server = Server()
        with lent_to_every_provider(server), embedding(variant):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url="http://localhost") as client:
                sent = await call_each(client, server)
        assert len(server.bodies) == 20 and all(server.bodies)
        pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        if pending:
            await asyncio.wait(pending, timeout=5)
        return sent
    finally:
        db.MIGRATIONS_DIR = real
        if was is None:
            os.environ.pop("EVERMIND_DATA_DIR", None)
        else:
            os.environ["EVERMIND_DATA_DIR"] = was


def same_request(recorded: dict, sent: dict) -> bool:
    """Whether a body is the one 3.7.0 sent, but for what the plan lets change: an
    OpenAI-compatible server asked for its counts."""
    sent = without_usage_asked(recorded, sent)
    return json.dumps(recorded, sort_keys=True) == json.dumps(sent, sort_keys=True)


def test_the_first_exception_is_include_usage_alone():
    openai = {"model": "brume:12b", "messages": [], "stream": True}
    anthropic = {"model": "aurore-3", "system": "You are Serana.", "messages": [], "stream": True}
    asked = {"stream_options": {"include_usage": True}}
    assert same_request(openai, {**openai, **asked})
    assert same_request(openai, openai)  # a server that refused it is asked without
    assert not same_request(openai, {**openai, "stream_options": {"include_usage": False}})
    assert not same_request(openai, {**openai, "stream_options": {"include_usage": True,
                                                                   "continuous_usage_stats": True}})
    assert not same_request(openai, {**openai, **asked, "temperature": 0.8})
    assert not same_request(anthropic, {**anthropic, **asked})


# What 3.7.0 left under the window, whatever the AI.
MARGIN_BEFORE = 200
# The history a variant's way rereads: the old setting it had, kept by the update.
HISTORY = {"untouched": 24, "touched": 4, "recalling": 4}


def same_context(recorded: dict, sent: dict, history_limit: int) -> bool:
    """Whether a turn's meta.context is the one 3.7.0 wrote, but for what the plan lets change:
    the budget under the wider margin of an AI that has measured nothing (the seed's AIs), and
    the three keys 3.8.0 adds, each checked here: the room kept for the reply, the same as 3.7.0
    kept; the history the way rereads; and what the card, the reminders and the story take of
    what is used."""
    window = recorded["context_size"]
    # Over the engine's floor of 512, the budget says the room 3.7.0 kept.
    assert recorded["budget"] > 512, recorded
    room = window - MARGIN_BEFORE - recorded["budget"]
    expected = {**recorded, "budget": max(512, window - room - margin_for({}, window)),
                "reply_room": room, "history_limit": history_limit}
    parts = sent.get("parts")
    if not isinstance(parts, dict) or set(parts) != {"card", "reminders", "history"}:
        return False
    if sum(parts.values()) != sent["used_tokens"] or min(parts.values()) < 0:
        return False
    rest = {key: value for key, value in sent.items() if key != "parts"}
    return json.dumps(expected, sort_keys=True) == json.dumps(rest, sort_keys=True)


def test_the_second_exception_is_the_margin_alone():
    recorded = {"used_tokens": 300, "budget": 15160, "context_size": 16384,
                "messages_included": 7, "messages_total": 7, "lore_matched": 0}
    parts = {"card": 100, "reminders": 0, "history": 200}
    sent = {**recorded, "budget": 16384 - 1024 - 983, "reply_room": 1024, "history_limit": 24,
            "parts": parts}
    assert same_context(recorded, sent, 24)
    assert not same_context(recorded, {**sent, "budget": 15160}, 24)
    assert not same_context(recorded, {**sent, "reply_room": 2048}, 24)
    assert not same_context(recorded, {**sent, "history_limit": 4}, 24)
    assert not same_context(recorded, {**sent, "messages_included": 6}, 24)
    assert not same_context(recorded, {k: v for k, v in sent.items() if k != "parts"}, 24)
    assert not same_context(recorded, {**sent, "parts": {**parts, "card": 99}}, 24)
    assert not same_context(recorded, {**sent, "extra": 1}, 24)


async def record() -> dict:
    out = {}
    for variant in VARIANTS:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            out[variant] = await sent_in(variant, Path(folder))
    return out


async def test_what_3_7_0_sent_is_sent_again(tmp_path):
    from app.services import limits

    recorded = json.loads(RECORDED.read_text(encoding="utf-8"))
    assert set(recorded) == set(VARIANTS)
    for variant in VARIANTS:
        folder = tmp_path / variant
        folder.mkdir()
        sent = await sent_in(variant, folder)
        await limits.drain()
        assert set(sent) == set(recorded[variant])
        for conn_id, calls in recorded[variant].items():
            for call in CALLS:
                assert same_request(calls[call], sent[conn_id][call]), (variant, conn_id, call)
            assert same_context(calls["turn_context"], sent[conn_id]["turn_context"],
                                HISTORY[variant]), (variant, conn_id)


def test_the_recording_is_whole():
    recorded = json.loads(RECORDED.read_text(encoding="utf-8"))
    before = json.loads(BEFORE.read_text(encoding="utf-8"))["requests"]
    for variant, requests in recorded.items():
        assert set(requests) == set(before), variant
        for conn_id, calls in requests.items():
            assert all(calls[call] for call in CALLS) and calls["turn_context"], (variant, conn_id)
    touched = recorded["touched"]
    for conn_id, calls in touched.items():
        assert calls["turn_context"]["messages_included"] == 4, conn_id
        assert "LENGTH OVERRIDE: write expansive replies" in json.dumps(calls["turn"]), conn_id
    # The passages of the long first message, and the room the length gave: the only variant
    # that holds the passage budget and the reply room against what 3.7.0 sent.
    for conn_id, calls in recorded["recalling"].items():
        assert "RELEVANT PAST" in json.dumps(calls["turn"]), conn_id
        assert LONG_FIRST_MESSAGE[:40] in json.dumps(calls["turn"]), conn_id
    for conn_id in AUTO:
        assert (recorded["recalling"][conn_id]["turn"] != touched[conn_id]["turn"]), conn_id
    # Never touched, 3.7.0 sent what 3.6.0 sent.
    for conn_id, calls in recorded["untouched"].items():
        for call in CALLS:
            assert same_request(before[conn_id][call], calls[call]), (conn_id, call)


if __name__ == "__main__":
    if sys.argv[1:] != ["--record"]:
        sys.exit("usage: python -m tests.test_requests_3_7 --record")
    recorded = asyncio.run(record())
    RECORDED.parent.mkdir(exist_ok=True)
    RECORDED.write_text(json.dumps(recorded, indent=1, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    print(f"recorded {RECORDED}")
