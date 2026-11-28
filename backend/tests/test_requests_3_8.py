"""The requests each AI sent in 3.8.0, kept in fixtures/requests_3_8.json so that the update that
counts every call can be shown to send every model the same ones, with no exception at all.

The seed is the one of requests_before.json, brought to 3.8.0 (every migration up to 022 run on
it), then, by SQL, what 3.8.0 added and the seeds before never meet, in three variants:
``ways`` (four conversations in a way of their own: light, immersive, maximum, and balanced with
overrides of its own), ``measured`` (every AI has had its replies counted, and one that reasons
keeps its room to the AI), and ``widened`` (``measured``, and one AI that a reply cut for want of
room has given a wider margin). For each, the four calls of every connection and the turn's
meta.context, as test_requests_before holds them.

It is recorded, never written by hand, on the code of 3.8.0 (the base of the spending plan):
``python -m tests.test_requests_3_8 --record`` from backend/ of that code. A body or a context
that differs from the recording by one character fails: a later release that must send something
else records its own file, this one is never edited.
"""

import asyncio
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

import httpx

from app import db
from app.config import db_path

from .test_requests_before import (
    CALLS,
    Server,
    call_each,
    lent_to_every_provider,
    put_seed,
)
from .test_requests_before import RECORDED as BEFORE

RECORDED = Path(__file__).resolve().parent / "fixtures" / "requests_3_8.json"
# The seed is written as the release before the AIs had it, then the migrations bring it to 3.8.0.
SEEDED_BEFORE = "021_my_ais.sql"
LAST_OF_3_8 = "022_ways_of_playing.sql"

# The way each conversation plays, by SQL: (play_style, play_overrides as the engine stores them).
WAYS = {
    "x-ollama": ("light", None),
    "x-openai": ("immersive", None),
    "x-anthropic": ("maximum", None),
    "x-anthropic-unset": ("balanced", {"reply_length": "long", "history_limit": 10}),
}
# The AI that reasons and keeps its room to the AI, and the one a refusal has widened.
REASONING = "c-ollama"
WIDENED = "c-openai"
VARIANTS = ("ways", "measured", "widened")


def three_eight(conn: sqlite3.Connection, variant: str) -> None:
    """What the seed holds on top of the migrations, as 3.8.0 wrote it."""
    if variant == "ways":
        for convo_id, (way, overrides) in WAYS.items():
            conn.execute("UPDATE conversations SET play_style = ?, play_overrides = ?"
                         " WHERE id = ?",
                         (way, None if overrides is None else json.dumps(overrides), convo_id))
        return
    conn.execute("UPDATE models SET token_ratio = 1.15, token_ratio_n = 4, usage_seen = 1")
    conn.execute("UPDATE models SET reasons = 1, reply_cap_mode = 'auto', reply_cap_tokens = NULL,"
                 " reply_tokens_avg = ? WHERE id = ?",
                 (json.dumps({"thinking": {"avg": 900, "n": 3}}), REASONING))
    if variant == "widened":
        conn.execute("UPDATE models SET fit_margin = 0.2 WHERE id = ?", (WIDENED,))


async def sent_in(variant: str, folder: Path) -> dict:
    """The seed of 3.6.0 brought to 3.8.0 with ``variant``'s rows, then to the code this runs on,
    and every call of every connection: {connection: {call: body, ..., "turn_context": ...}}."""
    seed = json.loads(BEFORE.read_text(encoding="utf-8"))["seed"]
    real = db.MIGRATIONS_DIR
    migrations = folder / "migrations"
    migrations.mkdir()
    for path in real.glob("*.sql"):
        if path.name < SEEDED_BEFORE:
            shutil.copy(path, migrations / path.name)
    was = os.environ.get("EVERMIND_DATA_DIR")
    os.environ["EVERMIND_DATA_DIR"] = str(folder / "data")
    db.MIGRATIONS_DIR = migrations
    try:
        await db.init_db()
        conn = sqlite3.connect(db_path())
        try:
            put_seed(conn, seed)
            conn.commit()
        finally:
            conn.close()
        for path in real.glob("*.sql"):
            if path.name <= LAST_OF_3_8:
                shutil.copy(path, migrations / path.name)
        await db.init_db()  # 3.8.0
        conn = sqlite3.connect(db_path())
        try:
            three_eight(conn, variant)
            conn.commit()
        finally:
            conn.close()
        for path in real.glob("*.sql"):
            shutil.copy(path, migrations / path.name)

        from app.main import create_app

        app = create_app()
        await db.init_db()  # the update
        server = Server()
        with lent_to_every_provider(server):
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


def same(recorded: dict, sent: dict) -> bool:
    """Strict JSON equality: no field added, none moved, no exception."""
    return json.dumps(recorded, sort_keys=True) == json.dumps(sent, sort_keys=True)


def test_equality_is_strict():
    body = {"model": "brume:12b", "messages": [], "stream": True}
    assert same(body, {"stream": True, "messages": [], "model": "brume:12b"})
    assert not same(body, {**body, "stream_options": {"include_usage": True}})
    assert not same(body, {**body, "stream": False})


async def record() -> dict:
    out = {}
    for variant in VARIANTS:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            out[variant] = await sent_in(variant, Path(folder))
    return out


async def test_what_3_8_0_sent_is_sent_again(tmp_path):
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
            for call in (*CALLS, "turn_context"):
                assert same(calls[call], sent[conn_id][call]), (variant, conn_id, call)


def test_the_recording_is_whole():
    recorded = json.loads(RECORDED.read_text(encoding="utf-8"))
    before = json.loads(BEFORE.read_text(encoding="utf-8"))["requests"]
    for variant, requests in recorded.items():
        assert set(requests) == set(before), variant
        for conn_id, calls in requests.items():
            assert all(calls[call] for call in CALLS) and calls["turn_context"], (variant, conn_id)
    # The ways read by the engine: light rereads 16 messages, maximum the whole story (0).
    ways = recorded["ways"]
    assert ways["c-ollama"]["turn_context"]["history_limit"] == 16
    assert ways["c-anthropic"]["turn_context"]["history_limit"] == 0
    assert ways["c-anthropic-unset"]["turn_context"]["history_limit"] == 10
    # An AI that reasons and keeps its room to the AI sends no ceiling.
    assert "max_tokens" not in recorded["measured"][REASONING]["turn"]
    assert "max_tokens" in recorded["ways"][REASONING]["turn"]
    # A wider margin leaves the prompt less room.
    assert (recorded["widened"][WIDENED]["turn_context"]["budget"]
            < recorded["measured"][WIDENED]["turn_context"]["budget"])


if __name__ == "__main__":
    if sys.argv[1:] != ["--record"]:
        sys.exit("usage: python -m tests.test_requests_3_8 --record")
    recorded = asyncio.run(record())
    RECORDED.parent.mkdir(exist_ok=True)
    RECORDED.write_text(json.dumps(recorded, indent=1, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    print(f"recorded {RECORDED}")
