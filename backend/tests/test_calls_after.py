"""The money that comes after a call: OpenRouter's record of a generation, read once it is done on
its side, for a call stopped or with no price; and a price typed later, for the calls that had
none.

The generation records below are written by hand in the shape OpenRouter documents
(GET /api/v1/generation, checked on 25 November 2026 against its reference). # shape unverified"""

import asyncio
import logging
import sqlite3
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app import db
from app.config import db_path
from app.repositories import models as models_repo
from app.services import calls

from .conftest import within
from .helpers import add_model
from .test_calls_capture import GENERATION, SERVED, held, two_pieces_in
from .test_my_ais_api import HOSTED, KEY, LMSTUDIO, OPENROUTER, Lists, Model, conversation_on

RECORD = {"data": {
    "id": GENERATION, "total_cost": 0.0042, "upstream_inference_cost": None,
    "native_tokens_prompt": 1830, "native_tokens_completion": 61,
    "native_tokens_reasoning": 12, "native_tokens_cached": 400, "is_byok": False,
}}


@pytest.fixture()
def lists(monkeypatch) -> Lists:
    from app.providers import catalog

    served = Lists({"/api/v1/models": {"data": [{"id": SERVED}]}, "/api/v1/key": {"data": {}}})
    monkeypatch.setattr(catalog, "client_factory", served.factory)
    return served


@pytest.fixture()
def records(monkeypatch) -> Lists:
    """OpenRouter's generation records, looked at without waiting."""
    served = Lists({"/api/v1/generation": RECORD})
    monkeypatch.setattr(calls, "RECONCILE_AFTER_S", (0, 0))
    monkeypatch.setattr(calls, "client_factory", served.factory)
    return served


def rows() -> dict[str, dict]:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    try:
        return {r["id"]: dict(r) for r in conn.execute("SELECT * FROM calls")}
    finally:
        conn.close()


def write_row(row_id: str, **columns) -> dict:
    """A finished row as a call leaves one, ``columns`` winning; written by SQL."""
    row = {"id": row_id, "started_at": calls.instant(), "ended_at": calls.instant(),
           "purpose": "reply", "outcome": "stopped", "family": "openrouter",
           "generation_id": GENERATION, "tokens_in": 1500, "tokens_out": 20,
           "tokens_source": "estimated", "cost_source": "none", **columns}
    conn = sqlite3.connect(db_path())
    try:
        conn.execute(f"INSERT INTO calls ({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})",
                     tuple(row.values()))
        conn.commit()
    finally:
        conn.close()
    return row


async def openrouter_ai(client) -> dict:
    return await add_model(client, base_url=OPENROUTER, model=SERVED, api_key=KEY, name="Aurore",
                           as_added=True)


async def looked_at(row: dict) -> None:
    """Both ways a row is looked at: at its end, and at the server's start."""
    calls._after_end(row)
    await calls.after_start()
    await within(5, calls.drain())


# OpenRouter's record.


async def test_a_stopped_openrouter_call_takes_its_cost_from_the_generation_record(
        client, lists, records, monkeypatch):
    ai = await openrouter_ai(client)
    convo = await conversation_on(client, ai["id"])
    Model(held).serve(monkeypatch)
    turn = await two_pieces_in(client, convo["id"])
    assert (await client.delete(f"/api/conversations/{convo['id']}/turn")).status_code == 204
    await within(5, turn.finished.wait())
    await within(5, calls.drain())

    [row] = rows().values()
    assert (row["outcome"], row["cost"], row["cost_source"]) == ("stopped", 0.0042, "reported")
    assert (row["tokens_in"], row["tokens_out"], row["tokens_reasoning"], row["tokens_cached"]) == (
        1830, 61, 12, 400)
    assert row["tokens_source"] == "server"
    assert row["cost_upstream"] is None
    assert row["reconciled_at"] is not None
    [asked] = records.requests
    assert asked.url.path == "/api/v1/generation"
    assert asked.url.params["id"] == GENERATION
    assert asked.headers["authorization"] == f"Bearer {KEY}"


async def test_a_first_404_is_not_an_error(client, lists, records, caplog):
    ai = await openrouter_ai(client)
    looks = iter([httpx.Response(404, json={"error": {"message": "Generation not found"}})])
    records.routes["/api/v1/generation"] = lambda request: next(looks, httpx.Response(
        200, json=RECORD))
    row = write_row("a", model_id=ai["id"], service_id=ai["service"]["id"])
    caplog.set_level(logging.DEBUG, logger="app.services.calls")
    calls._after_end(row)
    await within(5, calls.drain())

    assert rows()["a"]["cost_source"] == "reported"
    assert len(records.requests) == 2
    said = [r.levelno for r in caplog.records if r.name == "app.services.calls"]
    # Found, it says so once; the 404 before it says nothing.
    assert said == [logging.INFO]


async def test_byok_takes_the_upstream_from_the_record(client, lists, records):
    ai = await openrouter_ai(client)
    records.routes["/api/v1/generation"] = {"data": {
        **RECORD["data"], "total_cost": 0.0003, "upstream_inference_cost": 0.01, "is_byok": True}}
    row = write_row("a", model_id=ai["id"], service_id=ai["service"]["id"])
    await looked_at(row)

    found = rows()["a"]
    assert (found["cost"], found["cost_upstream"], found["cost_source"]) == (
        0.0003, 0.01, "reported")


async def test_other_services_are_never_asked(client, lists, records):
    ai = await openrouter_ai(client)
    hosted = await add_model(client, base_url=HOSTED, model="aurore", name="Hosted",
                             as_added=True)
    for row_id, family, made in (("anthropic", "anthropic", ai), ("generic", "generic", hosted)):
        await looked_at(write_row(row_id, family=family, model_id=made["id"],
                                  service_id=made["service"]["id"]))
    assert records.requests == []
    assert {r["cost_source"] for r in rows().values()} == {"none"}


async def test_a_reported_cost_is_never_asked_again(client, lists, records):
    ai = await openrouter_ai(client)
    row = write_row("a", model_id=ai["id"], service_id=ai["service"]["id"], cost=0.002,
                    cost_source="reported", outcome="whole", tokens_source="server")
    await looked_at(row)
    assert records.requests == []

    # Nor is one read once from the record.
    write_row("b", model_id=ai["id"], service_id=ai["service"]["id"])
    assert await calls.reconcile_row("b") is True
    assert await calls.reconcile_row("b") is False
    await looked_at(rows()["b"])
    assert len(records.requests) == 1


async def test_past_an_hour_a_row_is_left_as_it_is(client, lists, records):
    ai = await openrouter_ai(client)
    started = calls.instant(datetime.now(UTC) - timedelta(minutes=61))
    row = write_row("a", model_id=ai["id"], service_id=ai["service"]["id"], started_at=started,
                    ended_at=started)
    await looked_at(row)
    assert records.requests == []
    assert rows()["a"]["cost_source"] == "none"


async def test_a_refused_call_and_a_gone_service_are_never_asked(client, lists, records):
    ai = await openrouter_ai(client)
    await looked_at(write_row("refused", model_id=ai["id"], service_id=ai["service"]["id"],
                              outcome="refused", cost=0.0))
    await looked_at(write_row("gone", model_id="ai-gone", service_id="svc-gone"))
    assert records.requests == []


async def test_a_row_left_running_by_a_killed_process_is_stopped_then_reconciled(
        client, lists, records):
    ai = await openrouter_ai(client)
    conn = sqlite3.connect(db_path())
    try:
        conn.execute(
            "INSERT INTO calls (id, started_at, purpose, outcome, family, model_id, service_id,"
            " generation_id, tokens_in) VALUES ('left', ?, 'reply', 'running', 'openrouter', ?, ?,"
            " ?, 1500)", (calls.instant(), ai["id"], ai["service"]["id"], GENERATION))
        conn.commit()
    finally:
        conn.close()
    await calls.after_start()
    await within(5, calls.drain())

    row = rows()["left"]
    assert (row["outcome"], row["cost"], row["cost_source"]) == ("stopped", 0.0042, "reported")
    assert len(records.requests) == 1


async def test_a_look_waiting_for_its_time_is_cancelled_by_the_server_s_stop(
        client, lists, records, monkeypatch):
    monkeypatch.setattr(calls, "RECONCILE_AFTER_S", (20, 120))
    ai = await openrouter_ai(client)
    calls._after_end(write_row("a", model_id=ai["id"], service_id=ai["service"]["id"]))
    assert calls._tasks
    await within(2, calls.stop())
    assert not calls._tasks
    assert records.requests == []


async def test_a_look_an_end_schedules_while_the_server_stops_is_cancelled(
        client, lists, records, monkeypatch):
    monkeypatch.setattr(calls, "RECONCILE_AFTER_S", (20, 120))
    ai = await openrouter_ai(client)
    row = write_row("a", model_id=ai["id"], service_id=ai["service"]["id"])
    real, began, release = calls._write, asyncio.Event(), asyncio.Event()

    async def write(sql: str, params, **kwargs) -> int:
        if sql.startswith("UPDATE calls SET ended_at"):
            began.set()
            await release.wait()
        return await real(sql, params, **kwargs)

    monkeypatch.setattr(calls, "_write", write)
    ending = calls.Recording(None, ({}, {}), calls.Who("reply"), attempt=0, prompt_estimate=0)
    ending.row_id = "a"
    calls._spawn(ending._end({**dict.fromkeys(calls._ENDED), **row}))
    await within(2, began.wait())
    stopping = asyncio.ensure_future(calls.stop())
    await asyncio.sleep(0.05)
    # The end is written while the stop drains, and only then schedules its look.
    release.set()
    await within(1, stopping)
    assert not calls._tasks
    assert records.requests == []


async def test_a_record_that_says_no_cost_writes_nothing(client, lists, records):
    ai = await openrouter_ai(client)
    records.routes["/api/v1/generation"] = {"data": {**RECORD["data"], "total_cost": None}}
    await looked_at(write_row("a", model_id=ai["id"], service_id=ai["service"]["id"]))
    assert (rows()["a"]["cost_source"], rows()["a"]["reconciled_at"]) == ("none", None)


def change_service(service_id: str, **columns) -> None:
    conn = sqlite3.connect(db_path())
    try:
        conn.execute(f"UPDATE connections SET {', '.join(f'{c} = ?' for c in columns)}"
                     " WHERE id = ?", (*columns.values(), service_id))
        conn.commit()
    finally:
        conn.close()


@pytest.mark.parametrize("change", [
    # Moved to another address, of another family: the key goes nowhere but OpenRouter.
    {"provider": "openai-compatible", "base_url": "http://elsewhere.example/v1",
     "family": "generic", "family_url": None},
    # Its key taken away: nothing to ask with.
    {"api_key": ""},
], ids=["moved", "no-key"])
async def test_a_service_changed_since_the_call_is_never_asked(client, lists, records, change):
    ai = await openrouter_ai(client)
    write_row("a", model_id=ai["id"], service_id=ai["service"]["id"])
    change_service(ai["service"]["id"], **change)
    before = rows()
    assert await calls.reconcile_row("a") is False
    await looked_at(rows()["a"])
    assert records.requests == []
    assert rows() == before


async def test_a_row_with_no_generation_id_or_still_running_is_never_asked(client, lists,
                                                                          records):
    ai = await openrouter_ai(client)
    write_row("no-id", model_id=ai["id"], service_id=ai["service"]["id"], generation_id=None)
    assert await calls.reconcile_row("no-id") is False
    await looked_at(rows()["no-id"])
    # Still running, its end is still to come (the server's start stops it first).
    write_row("running", model_id=ai["id"], service_id=ai["service"]["id"], outcome="running",
              ended_at=None)
    assert await calls.reconcile_row("running") is False
    assert records.requests == []


@pytest.mark.parametrize("columns", [
    {"generation_id": None}, {"cost_source": "reported", "cost": 0.002},
    {"reconciled_at": "2026-11-26T10:00:00.000+00:00"}, {"outcome": "running"},
    {"outcome": "refused"}, {"family": "generic"},
    {"started_at": calls.instant(datetime.now(UTC) - timedelta(minutes=61))},
], ids=["no-id", "reported", "reconciled", "running", "refused", "other-family", "too-old"])
async def test_a_row_that_does_not_qualify_schedules_no_look(client, lists, records, columns):
    # A look that would find nothing is not even waited for: each call's end would otherwise
    # leave a task asleep for two minutes.
    ai = await openrouter_ai(client)
    calls._after_end(write_row("a", model_id=ai["id"], service_id=ai["service"]["id"],
                               **columns))
    assert not calls._tasks


async def test_two_looks_at_once_write_once(client, lists, records, caplog):
    ai = await openrouter_ai(client)
    write_row("a", model_id=ai["id"], service_id=ai["service"]["id"])

    async def slow(request):
        await asyncio.sleep(0.2)
        return RECORD

    records.routes["/api/v1/generation"] = slow
    caplog.set_level(logging.DEBUG, logger="app.services.calls")
    found = await within(5, asyncio.gather(calls.reconcile_row("a"), calls.reconcile_row("a")))
    assert sorted(found) == [False, True]
    assert len(records.requests) == 2
    said = [r.levelno for r in caplog.records if r.name == "app.services.calls"]
    assert said == [logging.INFO]


async def test_a_record_without_counts_leaves_the_estimate_said_as_one(client, lists, records):
    ai = await openrouter_ai(client)
    records.routes["/api/v1/generation"] = {"data": {
        "id": GENERATION, "total_cost": 0.0042, "upstream_inference_cost": None,
        "native_tokens_prompt": None, "native_tokens_completion": None, "is_byok": False}}
    await looked_at(write_row("a", model_id=ai["id"], service_id=ai["service"]["id"]))
    row = rows()["a"]
    assert (row["cost"], row["cost_source"]) == (0.0042, "reported")
    assert (row["tokens_in"], row["tokens_out"], row["tokens_source"]) == (1500, 20, "estimated")


def _times_out(request: httpx.Request):
    # A transport's error may carry what was sent, the key with it.
    raise httpx.ReadTimeout(f"timed out: {request.headers['authorization']}", request=request)


def _refuses(request: httpx.Request):
    raise httpx.ConnectError(f"refused: {request.headers['authorization']}", request=request)


@pytest.mark.parametrize("answer", [
    _times_out,
    _refuses,
    httpx.Response(500, json={"error": {"message": "internal"}}),
    httpx.Response(401, json={"error": {"message": "bad key"}}),
    httpx.Response(200, content=b"<html>not json</html>"),
    httpx.Response(200, json=["not", "a", "record"]),
    {"data": {**RECORD["data"], "total_cost": -0.01}},
    httpx.Response(200, content=b'{"data": {"total_cost": Infinity}}',
                   headers={"content-type": "application/json"}),
    httpx.Response(200, content=b'{"data": {"total_cost": NaN}}',
                   headers={"content-type": "application/json"}),
    {"data": {key: value for key, value in RECORD["data"].items() if key != "total_cost"}},
], ids=["timeout", "unreachable", "500", "401", "not-json", "not-a-record", "negative",
        "infinite", "nan", "no-total-cost"])
async def test_a_look_that_fails_writes_nothing_and_says_nothing(client, lists, records, caplog,
                                                                 answer):
    ai = await openrouter_ai(client)
    records.routes["/api/v1/generation"] = answer
    caplog.set_level(logging.DEBUG)
    await looked_at(write_row("a", model_id=ai["id"], service_id=ai["service"]["id"]))
    assert records.requests
    row = rows()["a"]
    assert (row["cost_source"], row["reconciled_at"]) == ("none", None)
    assert [r for r in caplog.records
            if r.name.startswith("app") and r.levelno > logging.DEBUG] == []
    assert KEY not in caplog.text


async def test_the_looks_at_start_never_hold_the_start(client, lists, records):
    ai = await openrouter_ai(client)
    conn = sqlite3.connect(db_path())
    try:
        conn.executemany(
            "INSERT INTO calls (id, started_at, ended_at, purpose, outcome, family, model_id,"
            " service_id, generation_id, tokens_in, tokens_out, tokens_source, cost_source)"
            " VALUES (?, ?, ?, 'reply', 'stopped', 'openrouter', ?, ?, ?, 1500, 20, 'estimated',"
            " 'none')",
            [(f"r{n}", calls.instant(), calls.instant(), ai["id"], ai["service"]["id"],
              f"gen-{n}") for n in range(200)])
        conn.commit()
    finally:
        conn.close()

    async def never(request):
        await asyncio.Event().wait()

    records.routes["/api/v1/generation"] = never
    await within(1, calls.after_start())
    # The pass is under way, waiting on OpenRouter; the server's stop does not wait for it.
    await asyncio.sleep(0.05)
    assert records.requests
    await within(1, calls.stop())
    assert not calls._tasks


# A price typed later.


def unpriced_rows(ai: dict, model: str) -> None:
    common = {"model_id": ai["id"], "service_id": ai["service"]["id"], "family": "generic",
              "generation_id": None, "model_asked": model, "tokens_in": 1000, "tokens_out": 50}
    write_row("whole", outcome="whole", tokens_cached=200, tokens_cache_write=100, **common)
    write_row("stopped", **common)
    write_row("refused", outcome="refused", cost=0.0, **{**common, "tokens_in": 0,
                                                         "tokens_out": 0})
    write_row("running", outcome="running", ended_at=None, **common)
    write_row("computed", outcome="whole", cost=0.5, cost_source="computed", price_in=1.0,
              price_out=2.0, price_source="read", **common)


async def test_a_price_typed_later_fills_only_unpriced_rows(client):
    ai = await add_model(client, base_url=HOSTED, model="aurore", name="Aurore", as_added=True)
    unpriced_rows(ai, "aurore")
    # Another AI, on another service, that asks for the same server id: its calls are its own.
    other = await add_model(client, base_url="https://other.example.com/v1", model="aurore",
                            name="Other", as_added=True)
    write_row("other", model_id=other["id"], service_id=other["service"]["id"], family="generic",
              generation_id=None, model_asked="aurore", outcome="whole", tokens_in=1000,
              tokens_out=50)
    before = rows()
    resp = await client.put(f"/api/models/{ai['id']}", json={"price_own_in": 3,
                                                             "price_own_out": 15})
    assert resp.status_code == 200, resp.text
    assert resp.json()["repriced"] == 2

    after = rows()
    whole = (max(0, 1000 - 200 - 100) * 3 + 200 * 3 + 100 * 2 * 3 + 50 * 15) / 1e6
    stopped = (1000 * 3 + 50 * 15) / 1e6
    for row_id, cost in (("whole", whole), ("stopped", stopped)):
        row = after[row_id]
        assert (row["price_in"], row["price_out"], row["price_source"]) == (3, 15, "typed_later")
        assert (row["cost_source"], row["local"]) == ("computed", 0)
        assert row["cost"] == pytest.approx(cost)
        assert (row["price_cache_read"], row["price_cache_write"]) == (None, None)
    for row_id in ("refused", "running", "computed", "other"):
        assert after[row_id] == before[row_id]


async def test_an_id_edited_in_place_does_not_reprice_the_earlier_model(client):
    ai = await add_model(client, base_url=HOSTED, model="a", name="Aurore", as_added=True)
    unpriced_rows(ai, "a")
    before = rows()
    resp = await client.put(f"/api/models/{ai['id']}", json={"model": "b", "price_own_in": 1,
                                                             "price_own_out": 2})
    assert resp.status_code == 200, resp.text
    assert resp.json()["repriced"] == 0
    assert rows() == before


async def test_one_half_of_a_price_prices_nothing(client):
    ai = await add_model(client, base_url=HOSTED, model="aurore", name="Aurore", as_added=True)
    unpriced_rows(ai, "aurore")
    before = rows()
    resp = await client.put(f"/api/models/{ai['id']}", json={"price_own_in": 3})
    assert resp.status_code == 200, resp.text
    assert resp.json()["repriced"] == 0
    assert rows() == before


async def test_a_save_that_sends_no_price_reprices_nothing(client):
    ai = await add_model(client, base_url=HOSTED, model="aurore", name="Aurore", as_added=True,
                         price_own_in=3, price_own_out=15)
    unpriced_rows(ai, "aurore")
    before = rows()
    resp = await client.put(f"/api/models/{ai['id']}", json={"name": "Aurore II"})
    assert resp.json()["repriced"] == 0
    assert rows() == before


async def test_a_typed_price_taken_away_leaves_the_read_one_to_new_calls(client):
    # Back to a price read: a read price that changes touches no row, nor does this.
    read = {"price": {"input": 1.0, "output": 2.0}}
    ai = await add_model(client, base_url=HOSTED, model="aurore", name="Aurore", read=read,
                         as_added=True, price_own_in=3, price_own_out=15)
    unpriced_rows(ai, "aurore")
    before = rows()
    resp = await client.put(f"/api/models/{ai['id']}", json={"price_own_in": None,
                                                             "price_own_out": None})
    assert resp.json()["repriced"] == 0
    assert rows() == before


async def test_a_local_ai_priced_later_leaves_free(client):
    ai = await add_model(client, base_url=LMSTUDIO, model="aurore", name="Aurore", as_added=True)
    assert ai["free"] is True
    write_row("home", model_id=ai["id"], service_id=ai["service"]["id"], family="lmstudio",
              generation_id=None, model_asked="aurore", local=1, loopback=1, outcome="whole",
              tokens_in=1000, tokens_out=50)
    resp = await client.put(f"/api/models/{ai['id']}", json={"price_own_in": 3,
                                                             "price_own_out": 15})
    assert resp.json()["repriced"] == 1
    row = rows()["home"]
    assert (row["local"], row["loopback"], row["cost_source"]) == (0, 1, "computed")
    assert row["cost"] == pytest.approx((1000 * 3 + 50 * 15) / 1e6)


async def test_a_failed_save_reprices_nothing(client, monkeypatch):
    ai = await add_model(client, base_url=HOSTED, model="aurore", name="Aurore", as_added=True)
    unpriced_rows(ai, "aurore")
    before = rows()
    from app.repositories import calls as calls_repo

    real = calls_repo.reprice

    async def then_fails(*args, **kwargs):
        await real(*args, **kwargs)
        raise RuntimeError("the save fails after the rows were priced")

    monkeypatch.setattr(calls_repo, "reprice", then_fails)
    conn = await db.connect()
    try:
        with pytest.raises(RuntimeError):
            await models_repo.update(conn, ai["id"], {"price_own_in": 3, "price_own_out": 15})
    finally:
        await conn.close()
    assert rows() == before
    model = next(m for m in (await client.get("/api/models")).json() if m["id"] == ai["id"])
    assert (model["price"]["own_in"], model["price"]["own_out"]) == (None, None)

