"""The requests each AI sent in 3.7.0, kept in fixtures/requests_3_7.json so that the update to
the ways of playing can be shown to send every model the same ones.

The seed is the one of requests_before.json, brought to 3.7.0 (every migration up to 021 run on
it, then the rest of them), in two variants of the three settings that were the way of playing,
written by SQL before the update: ``untouched`` (no row) and ``touched`` (reply_length "long",
history_limit 4, passage_budget 3000, as settings_repo.put writes them). For each, the four calls
of every connection and the turn's meta.context, as test_requests_before holds them.

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

RECORDED = Path(__file__).resolve().parent / "fixtures" / "requests_3_7.json"
MIGRATION = "021_my_ais.sql"

# The settings the release before kept as the way of playing, written as settings_repo.put does.
VARIANTS = {
    "untouched": {},
    "touched": {"reply_length": "long", "history_limit": 4, "passage_budget": 3000},
}


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


def same_request(recorded: dict, sent: dict) -> bool:
    """Whether a body is the one 3.7.0 sent."""
    return json.dumps(recorded, sort_keys=True) == json.dumps(sent, sort_keys=True)


def same_context(recorded: dict, sent: dict) -> bool:
    """Whether a turn's meta.context is the one 3.7.0 wrote."""
    return json.dumps(recorded, sort_keys=True) == json.dumps(sent, sort_keys=True)


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
            assert same_context(calls["turn_context"], sent[conn_id]["turn_context"]), (
                variant, conn_id)


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
