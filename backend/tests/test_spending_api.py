"""Spending: the sums of the calls, by period, AI, character, conversation and use, served small;
a deleted thing's money kept under its name or without it; the measured figure of an AI.

The rows are written by SQL, as a call leaves them: a whole reply that cost 0.01 $ unless told
otherwise."""

import csv
import io
import sqlite3
import time
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.config import db_path
from app.repositories.base import new_id
from app.services import calls

from .conftest import setup_conversation
from .helpers import add_model
from .test_my_ais_api import HOSTED

PARIS = {"tz": "Europe/Paris"}


def row_of(**fields) -> dict:
    started = fields.pop("started_at", None) or calls.instant()
    return {
        "id": new_id(), "started_at": started, "ended_at": started, "purpose": "reply",
        "attempt": 0, "outcome": "whole", "conversation_id": "convo-1",
        "conversation_title": "At the inn", "card_id": "card-1", "card_name": "Serana",
        "card_kind": "character", "model_id": "ai-1", "model_name": "Aurore",
        "service_id": "svc-1", "service_name": "Lumen", "family": "generic", "local": 0,
        "loopback": 0, "model_asked": "aurore", "tokens_in": 1000, "tokens_out": 100,
        "tokens_source": "server", "price_in": 5.0, "price_out": 50.0, "price_source": "read",
        "cost": 0.01, "cost_source": "computed", **fields,
    }


def put_calls(rows: list[dict]) -> None:
    conn = sqlite3.connect(db_path())
    try:
        columns = list(rows[0])
        conn.executemany(f"INSERT INTO calls ({', '.join(columns)})"
                         f" VALUES ({', '.join('?' for _ in columns)})",
                         [tuple(r[c] for c in columns) for r in rows])
        conn.commit()
    finally:
        conn.close()


def put_call(**fields) -> dict:
    row = row_of(**fields)
    put_calls([row])
    return row


def count_rows() -> int:
    conn = sqlite3.connect(db_path())
    try:
        return conn.execute("SELECT COUNT(*) FROM calls").fetchone()[0]
    finally:
        conn.close()


def spending_since() -> str:
    conn = sqlite3.connect(db_path())
    try:
        return conn.execute(
            "SELECT json_extract(value, '$') FROM settings WHERE key = 'spending_since'"
        ).fetchone()[0]
    finally:
        conn.close()


async def spending(client, **params) -> dict:
    resp = await client.get("/api/spending", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def detail(client, cut: str, key: str, **params) -> dict:
    resp = await client.get("/api/spending/detail", params={"cut": cut, "key": key, **params})
    assert resp.status_code == 200, resp.text
    return resp.json()


def by_id(lines: list[list]) -> dict:
    return {line[0]: line for line in lines}


# Days.


async def test_a_call_at_half_past_eleven_in_paris_is_that_day(client):
    put_call(started_at="2026-11-24T22:30:00.000+00:00")
    period = {"from": "2026-11-24", "to": "2026-11-25"}
    paris = await spending(client, **period, tz="Europe/Paris")
    assert paris["series"] == {"step": "day",
                               "points": [["2026-11-24", 0.01, 0], ["2026-11-25", 0, 0]]}
    tokyo = await spending(client, **period, tz="Asia/Tokyo")
    assert tokyo["series"]["points"] == [["2026-11-24", 0, 0], ["2026-11-25", 0.01, 0]]
    # Asked for a zone Python does not know, the page's own offset counts.
    offset = await spending(client, **period, tz="Mars/Base", tzo="540")
    assert offset["series"] == tokyo["series"]


async def test_the_bars_split_the_replies_from_the_rest_and_add_up_to_the_total(client):
    put_call(started_at="2026-11-24T10:00:00.000+00:00")
    put_call(started_at="2026-11-24T11:00:00.000+00:00", purpose="memory", cost=0.002)
    put_call(started_at="2026-11-25T10:00:00.000+00:00", purpose="regenerate", cost=0.003)
    got = await spending(client, **{"from": "2026-11-24", "to": "2026-11-25"}, **PARIS)
    assert got["series"]["points"] == [["2026-11-24", 0.01, 0.002], ["2026-11-25", 0.003, 0]]
    assert got["total"] == 0.015
    assert got["outside_replies"] == {"cost": 0.002, "calls": 1}


async def test_a_call_still_running_is_not_counted(client):
    put_call(outcome="running", cost=None, cost_source="none")
    got = await spending(client)
    assert (got["total"], got["calls"], got["models"]) == (0, 0, [])


async def test_the_previous_period_is_as_long_and_none_from_the_start(client):
    put_call(started_at="2026-10-20T10:00:00.000+00:00", cost=0.5)  # in the 25 days before
    put_call(started_at="2026-11-02T10:00:00.000+00:00")
    got = await spending(client, **{"from": "2026-11-01", "to": "2026-11-25"}, **PARIS)
    assert (got["total"], got["previous"]) == (0.01, 0.5)
    assert (await spending(client, to="2026-11-25", **PARIS))["previous"] is None


async def test_a_bad_period_is_refused(client):
    for params in ({"from": "2026-11-31"}, {"from": "2026-11-25", "to": "2026-11-24"},
                   {"tz": "../../etc"}, {"tz": "Europe/Paris\n"}, {"tzo": "900"},
                   {"tzo": "east"},
                   # Days a calendar can write but no play of today reaches.
                   {"from": "0001-01-01"}, {"to": "9999-12-31"},
                   {"from": "1000-01-01", "to": "2026-11-26"}, {"from": "1800-01-01"}):
        for path in ("", "/detail", "/export.csv"):
            resp = await client.get(f"/api/spending{path}",
                                    params={"cut": "use", "key": "reply", **params})
            assert resp.status_code == 422, (path, params)
            assert resp.json()["kind"] == "bad_period"
    for params in ({"before": "0001-01-01"}, {"before": "9999-12-31"},
                   {"tz": "Europe/Paris\n"}):
        resp = await client.delete("/api/spending", params={"dry_run": 1, **params})
        assert (resp.status_code, resp.json()["kind"]) == (422, "bad_period"), params
    resp = await client.get("/api/spending/total", params={"model": "a", "tz": "Europe/Paris\n"})
    assert (resp.status_code, resp.json()["kind"]) == (422, "bad_period")


async def test_a_folder_of_the_zone_base_takes_the_page_offset(client):
    put_call(started_at="2026-11-24T23:30:00.000+00:00")
    period = {"from": "2026-11-24", "to": "2026-11-25", "tzo": "60"}
    for name in ("America", "Etc", "Europe"):
        got = await spending(client, **period, tz=name)
        assert got["series"]["points"] == [["2026-11-24", 0, 0], ["2026-11-25", 0.01, 0]], name
        for path, extra in (("/detail", {"cut": "use", "key": "reply"}), ("/export.csv", {}),
                            ("/total", {"model": "ai-1", "days": "30"})):
            resp = await client.get(f"/api/spending{path}", params={**period, "tz": name, **extra})
            assert resp.status_code == 200, (path, name)
        resp = await client.delete("/api/spending", params={"tz": name, "tzo": "60",
                                                            "before": "2026-11-01",
                                                            "dry_run": 1})
        assert resp.status_code == 200, name


# What a sum counts.


async def test_the_total_never_follows_the_model_filter(client):
    put_call(cost=0.01, conversation_id="c-1")
    put_call(cost=0.02, model_id="ai-2", model_name="Brume", conversation_id="c-2",
             card_id="card-2", purpose="pen")
    got = await spending(client, model="ai-1")
    assert (got["total"], got["model_total"]) == (0.03, 0.01)
    assert [m[0] for m in got["models"]] == ["ai-2", "ai-1"]
    assert [c[0] for c in got["conversations"]] == ["c-1"]
    assert [c[0] for c in got["cards"]] == ["card-1"]
    assert [u[0] for u in got["uses"]] == ["reply"]
    assert got["series"]["points"][-1][1:] == [0.01, 0.02]
    assert (await spending(client))["model_total"] is None


async def test_free_rows_are_never_an_amount(client):
    put_call(model_id="ai-home", model_name="Home", local=1, loopback=1, cost=None,
             cost_source="none", price_in=None, price_out=None, price_source=None)
    put_call(model_id="ai-net", model_name="Net", local=1, cost=0.5, cost_source="reported")
    put_call(model_id="ai-free", model_name="Free", cost=0.0, price_in=0.0, price_out=0.0)
    put_call(model_id="ai-byok", model_name="Byok", family="openrouter", cost=0.0,
             cost_upstream=0.0123, cost_source="reported")
    got = await spending(client)
    assert got["total"] == 0.0123
    free = by_id(got["free"])
    assert set(free) == {"ai-home", "ai-net", "ai-free"}
    assert (free["ai-home"][2], free["ai-net"][2], free["ai-free"][2]) == (
        "pc", "network", "service")
    assert free["ai-home"][3:] == [1, 1000]
    [byok] = got["models"]
    assert (byok[0], byok[3], byok[4]) == ("ai-byok", 0, 0.0123)
    assert got["unpriced"] == {"calls": 0, "tokens_in": 0, "tokens_out": 0}
    [reply] = got["uses"]
    assert (reply[1], reply[2], reply[7]) == (0.0123, 4, 3)


async def test_refused_calls_are_counted_never_priced(client):
    put_call()
    put_call(outcome="refused", status=429, tokens_in=0, tokens_out=0, cost=0.0,
             cost_source="none")
    got = await spending(client)
    assert (got["total"], got["calls"]) == (0.01, 2)
    [model] = got["models"]
    assert (model[3], model[6], model[10]) == (0.01, 2, 0)
    assert got["unpriced"]["calls"] == 0
    assert got["conversations"][0][5] == 0


async def test_a_line_says_its_unpriced_calls(client):
    put_call()
    put_call(cost=None, cost_source="none", price_in=None, price_out=None, price_source=None,
             tokens_in=1200, tokens_out=80, tokens_source="estimated")
    got = await spending(client)
    assert got["total"] == 0.01
    assert got["models"][0][10] == 1
    assert got["conversations"][0][5] == 1
    assert got["cards"][0][5] == 1
    assert got["unpriced"] == {"calls": 1, "tokens_in": 1200, "tokens_out": 80}
    assert got["uses"] == [["reply", 0.01, 2, 0, 1, 1200, 80, 0]]


async def test_retried_attempts_are_counted_under_replies(client):
    put_call(attempt=0, outcome="refused", status=400, cost=0.0, cost_source="none")
    put_call(attempt=1)
    put_call(purpose="consolidation", cost=0.001)
    put_call(purpose="memory", cost=0.002, attempt=1)
    got = await spending(client)
    assert got["uses"] == [["reply", 0.01, 2, 1, 0, 0, 0, 0], ["memory", 0.003, 2, 1, 0, 0, 0, 0]]


async def test_where_the_money_comes_from(client):
    put_call(cost=0.004, cost_source="reported")
    put_call(cost=0.002, price_source="read", tokens_source="mixed")
    put_call(cost=0.001, price_source="typed_later")
    got = await spending(client)
    assert got["sources"] == {"reported": 0.004, "computed_read": 0.002, "computed_typed": 0.001,
                              "estimated": 0.002}


# The lists, and the names on them.


async def test_the_dearest_50_then_the_rest(client):
    put_calls([row_of(conversation_id=f"c-{n:02}", cost=(n + 1) / 1000) for n in range(60)])
    got = await spending(client)
    assert len(got["conversations"]) == 50
    assert [c[0] for c in got["conversations"][:2]] == ["c-59", "c-58"]
    lines, cost, calls_, unpriced = got["conversations_rest"]
    assert (lines, calls_, unpriced) == (10, 10, 0)
    assert cost == pytest.approx(sum(range(1, 11)) / 1000)
    assert got["cards_rest"] is None


async def test_a_new_card_s_drafts_are_one_line_and_speed_is_no_card(client):
    put_call(purpose="card", card_id=None, card_name=None, conversation_id=None, job_id="job-1")
    put_call(purpose="card", card_id=None, card_name=None, conversation_id=None, job_id="job-2")
    put_call(purpose="speed", card_id=None, card_name=None, card_kind=None,
             conversation_id=None)
    got = await spending(client)
    [new_card] = got["cards"]
    assert (new_card[0], new_card[1], new_card[4], new_card[7]) == (None, None, 2, False)
    assert got["conversations"] == []
    new = await detail(client, "card", "")
    assert (new["name"], new["calls"], new["deleted"]) == (None, 2, False)


async def test_a_deleted_conversation_keeps_its_rows_under_its_name(client):
    convo = await setup_conversation(client)
    put_call(conversation_id=convo["id"], conversation_title="At the inn",
             card_id=convo["character_id"])
    assert (await client.delete(f"/api/conversations/{convo['id']}")).status_code == 204
    got = await spending(client)
    [line] = got["conversations"]
    assert (line[0], line[1], line[2], line[3], line[7]) == (
        convo["id"], "At the inn", "Serana", 0.01, True)
    assert got["cards"][0][7] is False
    assert count_rows() == 1


async def test_a_renamed_conversation_shows_its_name_of_today(client):
    convo = await setup_conversation(client)
    put_call(conversation_id=convo["id"], conversation_title="At the inn",
             card_id=convo["character_id"], card_name="Old name")
    resp = await client.patch(f"/api/conversations/{convo['id']}", json={"title": "By the sea"})
    assert resp.status_code == 200, resp.text
    got = await spending(client)
    [line] = got["conversations"]
    assert (line[1], line[2], line[7]) == ("By the sea", "Serana", False)
    assert got["cards"][0][1] == "Serana"
    shown = await detail(client, "conversation", convo["id"])
    assert (shown["title"], shown["card_name"], shown["deleted"]) == (
        "By the sea", "Serana", False)


async def test_forget_name_on_delete_keeps_the_money_without_the_name(client):
    convo = await setup_conversation(client)
    put_call(conversation_id=convo["id"], card_id=convo["character_id"])
    put_call(conversation_id="another", conversation_title="Kept")
    resp = await client.delete(f"/api/conversations/{convo['id']}", params={"forget_name": 1})
    assert resp.status_code == 204
    got = by_id((await spending(client))["conversations"])
    assert (got[convo["id"]][1], got[convo["id"]][3], got[convo["id"]][7]) == (None, 0.01, True)
    assert got["another"][1] == "Kept"
    # A conversation that is not there is not found, and nothing is forgotten.
    resp = await client.delete("/api/conversations/another", params={"forget_name": 1})
    assert resp.status_code == 404
    assert by_id((await spending(client))["conversations"])["another"][1] == "Kept"


async def test_forgetting_a_card_forgets_its_conversations_titles(client):
    convo = await setup_conversation(client)
    card_id = convo["character_id"]
    put_call(conversation_id=convo["id"], card_id=card_id)
    put_call(purpose="card", conversation_id=None, conversation_title=None, card_id=card_id)
    resp = await client.delete(f"/api/characters/{card_id}", params={"forget_name": 1})
    assert resp.status_code == 204
    got = await spending(client)
    [card] = got["cards"]
    assert (card[0], card[1], card[3], card[7]) == (card_id, None, 0.02, True)
    [line] = got["conversations"]
    assert (line[1], line[2], line[7]) == (None, None, True)


async def test_forget_on_its_own(client):
    put_call(conversation_id="gone", conversation_title="At the inn")
    resp = await client.post("/api/spending/forget", json={"cut": "conversation", "key": "gone"})
    assert resp.json() == {"forgotten": 1}
    assert (await spending(client))["conversations"][0][1] is None
    resp = await client.post("/api/spending/forget", json={"cut": "everything", "key": "gone"})
    assert resp.status_code == 422


async def test_a_branch_copies_no_call(client):
    convo = await setup_conversation(client)
    put_call(conversation_id=convo["id"], card_id=convo["character_id"])
    messages = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    resp = await client.post(f"/api/messages/{messages[0]['id']}/branch")
    assert resp.status_code == 201, resp.text
    assert count_rows() == 1
    assert len((await spending(client))["conversations"]) == 1


# Since when, and clearing.


async def test_since_is_the_update_until_a_clear(client):
    noted = spending_since()
    put_call()
    assert (await spending(client))["since"] == noted
    # A row older than the update (a clock set back) is counted from its own start.
    put_call(started_at="2020-01-01T00:00:00.000+00:00")
    assert (await spending(client))["since"] == "2020-01-01T00:00:00.000+00:00"
    resp = await client.delete("/api/spending")
    assert resp.json()["deleted"] == 2
    since = resp.json()["since"]
    assert since > noted
    assert since == spending_since() == (await spending(client))["since"]
    assert (await spending(client))["total"] == 0


async def test_clearing_before_a_date(client):
    for day in ("2026-11-01", "2026-11-10", "2026-11-20"):
        put_call(started_at=f"{day}T12:00:00.000+00:00")
    params = {"before": "2026-11-20", "tz": "Europe/Paris"}
    dry = await client.delete("/api/spending", params={**params, "dry_run": 1})
    assert dry.json() == {"calls": 2, "first": "2026-11-01T12:00:00.000+00:00",
                          "last": "2026-11-10T12:00:00.000+00:00"}
    assert count_rows() == 3
    real = await client.delete("/api/spending", params=params)
    assert real.json() == {"deleted": 2, "since": "2026-11-20T12:00:00.000+00:00"}
    assert count_rows() == 1


async def test_clearing_leaves_a_running_call(client):
    put_call(started_at="2026-11-01T12:00:00.000+00:00", outcome="running", cost=None,
             cost_source="none")
    put_call(started_at="2026-11-01T12:00:00.000+00:00")
    assert (await client.delete("/api/spending", params={"dry_run": 1})).json()["calls"] == 1
    assert (await client.delete("/api/spending")).json()["deleted"] == 1
    assert count_rows() == 1


# The file.

EXPORTED = [
    "id", "started_at", "ended_at", "purpose", "attempt", "outcome", "status", "conversation_id",
    "conversation_title", "card_id", "card_name", "card_kind", "job_id", "message_id", "variant",
    "model_id", "model_name", "service_id", "service_name", "family", "local", "loopback",
    "model_asked", "model_served", "upstream", "generation_id", "tokens_in", "tokens_out",
    "tokens_cached", "tokens_cache_write", "tokens_reasoning", "tokens_source", "price_in",
    "price_out", "price_cache_read", "price_cache_write", "price_source", "cost",
    "cost_upstream", "cost_source", "currency", "reconciled_at",
]


async def test_the_export_is_every_column_but_usage_raw(client):
    put_call(started_at="2026-11-02T12:00:00.000+00:00", conversation_title="=HYPERLINK(\"x\")",
             card_name="-1+1", usage_raw='{"prompt_tokens": 1000}', cost=0.0123)
    put_call(started_at="2026-11-03T12:00:00.000+00:00", card_name="@Serana")
    put_call(started_at="2026-11-04T12:00:00.000+00:00", outcome="running")
    resp = await client.get("/api/spending/export.csv", params={"tz": "Europe/Paris"})
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "text/csv; charset=utf-8"
    today = datetime.now(ZoneInfo("Europe/Paris")).date()
    assert resp.headers["content-disposition"] == (
        f'attachment; filename="evermind-spending-{today.isoformat()}.csv"')
    header, *lines = list(csv.reader(io.StringIO(resp.text)))
    assert header == EXPORTED
    assert len(lines) == 2
    first = dict(zip(header, lines[0], strict=True))
    assert first["conversation_title"] == "'=HYPERLINK(\"x\")"
    assert first["card_name"] == "'-1+1"
    assert (first["cost"], first["tokens_in"], first["status"]) == ("0.0123", "1000", "")
    assert dict(zip(header, lines[1], strict=True))["card_name"] == "'@Serana"
    assert "prompt_tokens" not in resp.text
    # A period narrows it.
    resp = await client.get("/api/spending/export.csv",
                            params={"from": "2026-11-03", "to": "2026-11-03", "tz": "Europe/Paris"})
    assert len(list(csv.reader(io.StringIO(resp.text)))) == 2


# The measured figure.


async def measured_ai(client) -> dict:
    return await add_model(client, base_url=HOSTED, model="aurore", name="Aurore", as_added=True)


def replies(ai_id: str, n: int, **fields) -> list[dict]:
    start = datetime.now(UTC) - timedelta(days=1)
    return [row_of(model_id=ai_id, started_at=calls.instant(start + timedelta(seconds=i)),
                   **fields) for i in range(n)]


async def per100_of(client, ai_id: str) -> dict | None:
    [ai] = [m for m in (await client.get("/api/models")).json() if m["id"] == ai_id]
    return ai["per100"]


async def test_the_measured_figure_needs_20_replies(client):
    ai = await measured_ai(client)
    put_calls(replies(ai["id"], 19, cost=0.049))
    # Neither a refusal, nor a call stopped, nor one with no price, nor a pen count.
    put_calls(replies(ai["id"], 5, outcome="refused", cost=0.0, cost_source="none")
              + replies(ai["id"], 5, outcome="stopped")
              + replies(ai["id"], 5, cost=None, cost_source="none")
              + replies(ai["id"], 5, purpose="pen"))
    assert await per100_of(client, ai["id"]) is None
    put_calls(replies(ai["id"], 15, cost=0.049, purpose="regenerate"))
    measured = await per100_of(client, ai["id"])
    assert (measured["cost"], measured["n"], measured["typed"]) == (pytest.approx(4.9), 34, False)
    put_calls(replies(ai["id"], 106, cost=0.049))
    assert (await per100_of(client, ai["id"]))["n"] == 100


async def test_the_measured_figure_counts_only_the_model_named_now(client):
    ai = await measured_ai(client)
    put_calls(replies(ai["id"], 30, model_asked="aurore-old"))
    put_calls(replies(ai["id"], 5))
    assert await per100_of(client, ai["id"]) is None


async def test_the_measured_figure_says_a_typed_price(client):
    ai = await measured_ai(client)
    put_calls(replies(ai["id"], 19, cost_source="reported")
              + replies(ai["id"], 1, price_source="typed"))
    assert (await per100_of(client, ai["id"]))["typed"] is True


# The detail of a line.


async def test_the_detail_of_a_conversation_says_how_a_message_grew(client):
    put_calls([row_of(started_at=calls.instant(datetime.now(UTC) - timedelta(minutes=30 - n)),
                      cost=(n + 1) / 1000) for n in range(20)])
    got = await detail(client, "conversation", "convo-1")
    assert got["growth"] == {"first": 0.0015, "last": 0.0195}
    assert (got["title"], got["card_name"], got["deleted"], got["calls"]) == (
        "At the inn", "Serana", True, 20)
    assert got["models"] == [["ai-1", "Aurore", pytest.approx(0.21), 20, 0, False]]
    assert got["uses"] == [["reply", pytest.approx(0.21), 20, 0, 0]]
    put_call(conversation_id="short")
    assert (await detail(client, "conversation", "short"))["growth"] is None


async def test_the_detail_of_an_ai(client):
    ai = await measured_ai(client)
    put_call(model_id=ai["id"], cost_source="computed", tokens_cached=400, price_cache_read=None)
    put_call(model_id=ai["id"], purpose="pen", cost=None, cost_source="none")
    got = await detail(client, "model", ai["id"])
    assert (got["name"], got["deleted"], got["priceable"], got["per100"]) == (
        "Aurore", False, True, None)
    assert (got["cost"], got["calls"], got["unpriced_calls"], got["at_most"]) == (
        0.01, 2, 1, True)
    assert got["tokens"] == {"in": 2000, "out": 200, "cached": 400, "reasoning": 0}
    assert got["uses"] == [["reply", 0.01, 1, 0, 0], ["pen", 0, 1, 0, 1]]
    assert got["cards"] == [["card-1", "Serana", "character", 0.01, 2, True]]


async def test_the_detail_of_a_character_and_of_a_use(client):
    put_call(conversation_id="c-1")
    put_call(conversation_id="c-2", conversation_title="By the sea", cost=0.02)
    put_call(purpose="memory", conversation_id="c-2", cost=0.001)
    card = await detail(client, "card", "card-1")
    assert (card["name"], card["kind"], card["deleted"], card["cost"], card["calls"]) == (
        "Serana", "character", True, 0.031, 3)
    assert [c[0] for c in card["conversations"]] == ["c-2", "c-1"]
    memory = await detail(client, "use", "memory")
    assert (memory["cost"], memory["calls"], memory["models"][0][0]) == (0.001, 1, "ai-1")


async def test_a_line_with_nothing_in_the_period_is_not_found(client):
    put_call(started_at="2026-01-01T12:00:00.000+00:00")
    for cut, key in (("conversation", "convo-1"), ("use", "pen"), ("use", "nothing"),
                     ("model", "ai-1"), ("card", "card-1")):
        resp = await client.get("/api/spending/detail",
                                params={"cut": cut, "key": key, "from": "2026-11-01"})
        assert resp.status_code == 404, (cut, key)
        assert resp.json()["resource"] == "spending"


# The line on a page of its own.


async def test_total_for_the_panel_is_nothing_when_nothing_was_spent(client):
    resp = await client.get("/api/spending/total", params={"conversation": "convo-1"})
    assert resp.json() == {"total": 0, "currency": "USD", "calls": 0, "unpriced_calls": 0,
                           "free": False}
    put_call(local=1, cost=None, cost_source="none")
    resp = await client.get("/api/spending/total", params={"conversation": "convo-1"})
    assert resp.json() == {"total": 0, "currency": "USD", "calls": 1, "unpriced_calls": 0,
                           "free": True}
    assert len(resp.content) < 100


async def test_thirty_days_of_a_total_start_at_the_local_midnight_29_days_ago(client):
    tokyo = ZoneInfo("Asia/Tokyo")
    day = datetime.now(tokyo).date() - timedelta(days=29)
    first = datetime(day.year, day.month, day.day, tzinfo=tokyo)
    put_call(started_at=calls.instant(first - timedelta(minutes=1)), cost=0.5)
    put_call(started_at=calls.instant(first + timedelta(minutes=1)))
    resp = await client.get("/api/spending/total",
                            params={"model": "ai-1", "days": "30", "tz": "Asia/Tokyo"})
    assert (resp.json()["total"], resp.json()["calls"]) == (0.01, 1)
    resp = await client.get("/api/spending/total", params={"card": "card-1"})
    assert resp.json()["total"] == 0.51
    for params in ({}, {"card": "a", "model": "b"}):
        resp = await client.get("/api/spending/total", params=params)
        assert (resp.status_code, resp.json()["kind"]) == (422, "bad_period")


# A year of play.


async def test_a_year_of_calls_answers_small_and_quickly(client):
    today = datetime.now(UTC).date()
    start = datetime(today.year, today.month, today.day, tzinfo=UTC) - timedelta(days=364)
    rows = []
    for n in range(55_000):
        convo = n % 300
        rows.append(row_of(
            started_at=calls.instant(start + timedelta(seconds=n * 571)),
            conversation_id=f"convo-{convo:03}", conversation_title=f"Story {convo}",
            card_id=f"card-{convo:03}", card_name=f"Card {convo}",
            purpose=("reply", "reply", "reply", "memory", "regenerate")[n % 5],
            model_id=f"ai-{n % 4}", cost=0.0001 * (1 + n % 50)))
    put_calls(rows)
    began = time.perf_counter()
    resp = await client.get("/api/spending", headers={"Accept-Encoding": "gzip"})
    took = time.perf_counter() - began
    assert resp.status_code == 200
    assert resp.headers["content-encoding"] == "gzip"
    assert resp.num_bytes_downloaded < 8 * 1024
    assert took < 3, took
    got = resp.json()
    assert len(got["conversations"]) == 50 and len(got["cards"]) == 50
    assert got["conversations_rest"][0] == 250
    assert got["calls"] == 55_000
    assert got["series"]["step"] == "week"
