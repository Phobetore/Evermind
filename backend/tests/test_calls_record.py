"""What each call to a model leaves: one row, written when it starts and completed however it
ends, on connections of its own; and the rules that read its counts, its price and its cost.

The usage objects below are written by hand in the shapes the servers document."""

import asyncio
import json
import logging
import re
import sqlite3
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app import db
from app.config import db_path
from app.providers import CallFigures, ProviderError, complete_answer
from app.providers.base import UNREACHABLE
from app.providers.openai_compat import OpenAICompatProvider
from app.services import calls

from .conftest import OAI_CONN, PAYLOAD, sse, within

MODEL = {
    "id": "ai-1", "name": "Aurore", "model": "aurore/aurore-large",
    "price_in": None, "price_out": None, "price_own_in": None, "price_own_out": None,
    "price_cache_read": None, "price_cache_write": None,
    "token_ratio": None, "token_ratio_n": 0,
}
SERVICE = {
    "id": "svc-1", "name": "OpenRouter", "provider": "openai-compatible",
    "base_url": "https://openrouter.ai/api/v1", "family": "openrouter",
    "family_url": "https://openrouter.ai/api/v1",
}
WHO = calls.Who(purpose="reply", conversation_id="c-1", conversation_title="At the inn",
                card_id="card-1", card_name="Serana", card_kind="character",
                message_id="msg-1", variant=0)


def model(**fields) -> dict:
    return {**MODEL, **fields}


def service(base_url: str, family: str, provider: str = "openai-compatible") -> dict:
    return {**SERVICE, "provider": provider, "base_url": base_url, "family": family,
            "family_url": base_url}


@pytest.fixture()
async def database(tmp_path, monkeypatch):
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "data"))
    await db.init_db()


def rows() -> list[dict]:
    """The rows as another connection reads them: only what was committed."""
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM calls ORDER BY started_at")]
    finally:
        conn.close()


def serve(handler) -> OpenAICompatProvider:
    made = OpenAICompatProvider(OAI_CONN)
    made._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return made


def chunk(content: str) -> dict:
    return {"id": "gen-1", "model": "aurore/aurore-large", "provider": "Lumen",
            "choices": [{"delta": {"content": content}, "finish_reason": None}]}


class Held(httpx.AsyncByteStream):
    """Two pieces of a reply, then nothing more until the reader gives up."""

    async def __aiter__(self):
        yield sse([json.dumps(chunk("*She ")), json.dumps(chunk("waits"))])
        await asyncio.Event().wait()


class Waits(httpx.AsyncByteStream):
    """Nothing until ``go`` is set, then a whole reply."""

    def __init__(self, go: asyncio.Event):
        self.go = go

    async def __aiter__(self):
        await self.go.wait()
        yield sse([json.dumps(chunk("Hi.")), "[DONE]"])


async def read_until_two_pieces(provider, came: list):
    async def read():
        async with calls.recording(provider, (MODEL, SERVICE), WHO, prompt_estimate=400):
            async for event in provider.stream_chat(PAYLOAD):
                came.append(event)

    reading = asyncio.create_task(read())
    while len(came) < 2:
        await within(2, asyncio.sleep(0.01))
    return reading


# The rules, on their own.

def test_the_outcome_of_each_end():
    sent = CallFigures(sent=True)
    never = CallFigures()
    cases = [
        (None, sent, True, True, "stopped"),
        (asyncio.CancelledError(), sent, False, True, "stopped"),
        (ProviderError("Slow down.", status=429), sent, False, False, "refused"),
        (ProviderError("http://nobody/v1", UNREACHABLE), never, False, False, "refused"),
        (ProviderError("in stream"), sent, False, True, "failed"),
        (None, sent, False, False, "empty"),
        (None, sent, False, True, "whole"),
    ]
    for error, figures, stopped, wrote, outcome in cases:
        assert calls.outcome_of(error, figures, stopped=stopped, wrote=wrote) == outcome, error


def test_a_refusal_reads_nothing_and_costs_nothing():
    figures = CallFigures(usage={"prompt_tokens": 1200, "completion_tokens": 3, "cost": 0.5},
                          usage_final=True, sent=True, chars_out=40)
    tokens = calls.tokens_of(figures, outcome="refused", prompt_estimate=1000)
    assert tokens == calls.Tokens(0, 0, None, None, None, "server")
    pricing = calls.Pricing(1.0, 2.0, None, None, "read")
    assert calls.cost_of(figures, tokens, pricing, outcome="refused", local=False) == (
        0.0, None, "none")


def test_the_server_counts_win_once_final():
    figures = CallFigures(usage={
        "prompt_tokens": 1200, "completion_tokens": 340,
        "prompt_tokens_details": {"cached_tokens": 200},
        "completion_tokens_details": {"reasoning_tokens": 90}, "cost": 0.0021,
    }, usage_final=True, chars_out=900)
    tokens = calls.tokens_of(figures, outcome="whole", prompt_estimate=1000)
    assert tokens == calls.Tokens(1200, 340, 200, None, 90, "server")
    none = calls.Pricing(None, None, None, None, None)
    assert calls.cost_of(figures, tokens, none, outcome="whole", local=False) == (
        0.0021, None, "reported")


def test_anthropic_input_adds_its_cache():
    figures = CallFigures(usage={"input_tokens": 100, "cache_read_input_tokens": 800,
                                 "cache_creation_input_tokens": 50, "output_tokens": 210},
                          usage_final=True)
    tokens = calls.tokens_of(figures, outcome="whole", prompt_estimate=1000)
    assert (tokens.tokens_in, tokens.tokens_out, tokens.cached, tokens.cache_write) == (
        950, 210, 800, 50)
    pricing = calls.pricing_of(model(price_in=3.0, price_out=15.0))
    assert calls.money_of(tokens, pricing) == pytest.approx(
        (100 * 3 + 800 * 3 + 50 * 6 + 210 * 15) / 1e6)
    assert calls.money_of(tokens, pricing) == pytest.approx(0.00615)


def test_anthropic_thinking_tokens_are_read():
    # shape unverified: Anthropic's output_tokens_details.thinking_tokens, as documented.
    figures = CallFigures(usage={"input_tokens": 100, "output_tokens": 210,
                                 "output_tokens_details": {"thinking_tokens": 120}},
                          usage_final=True)
    assert calls.tokens_of(figures, outcome="whole", prompt_estimate=1).reasoning == 120


def test_a_detail_that_is_not_a_whole_number_is_not_read():
    figures = CallFigures(usage={"prompt_tokens": 100, "completion_tokens": 10,
                                 "prompt_tokens_details": {"cached_tokens": -3},
                                 "completion_tokens_details": {"reasoning_tokens": True}},
                          usage_final=True)
    tokens = calls.tokens_of(figures, outcome="whole", prompt_estimate=1)
    assert (tokens.cached, tokens.reasoning) == (None, None)


def test_a_stop_before_the_final_count_is_mixed():
    figures = CallFigures(usage={"input_tokens": 900, "output_tokens": 1}, chars_out=350)
    tokens = calls.tokens_of(figures, outcome="stopped", prompt_estimate=1000)
    assert (tokens.tokens_in, tokens.tokens_out, tokens.source) == (900, 101, "mixed")


async def test_no_count_is_estimated_from_what_arrived(database):
    class Says(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield sse([json.dumps(chunk("x" * 700)), "[DONE]"])

    provider = serve(lambda request: httpx.Response(200, stream=Says()))
    ai = (model(token_ratio=1.2, token_ratio_n=3), SERVICE)
    async with calls.recording(provider, ai, WHO, prompt_estimate=5000):
        await complete_answer(provider, PAYLOAD)
    assert provider.figures.usage == {}
    [row] = rows()
    assert (row["outcome"], row["tokens_in"], row["tokens_out"], row["tokens_source"]) == (
        "whole", 6000, 201, "estimated")


def test_a_byok_call_keeps_the_upstream_apart():
    # shape unverified: OpenRouter's cost_details.upstream_inference_cost with a key of one's own.
    figures = CallFigures(usage={"prompt_tokens": 1000, "completion_tokens": 100, "cost": 0,
                                 "cost_details": {"upstream_inference_cost": 0.0123}},
                          usage_final=True)
    tokens = calls.tokens_of(figures, outcome="whole", prompt_estimate=1)
    none = calls.Pricing(None, None, None, None, None)
    assert calls.cost_of(figures, tokens, none, outcome="whole", local=False) == (
        0.0, 0.0123, "reported")


def test_a_cost_that_is_not_a_number_is_not_reported():
    tokens = calls.Tokens(1000, 1000, None, None, None, "server")
    pricing = calls.Pricing(1.0, 2.0, None, None, "read")
    for cost in (True, -1, float("nan"), float("inf"), "0.1"):
        figures = CallFigures(usage={"cost": cost})
        assert calls.cost_of(figures, tokens, pricing, outcome="whole", local=False) == (
            pytest.approx(0.003), None, "computed"), cost


def test_at_home_nothing_is_ever_money():
    figures = CallFigures(usage={"prompt_tokens": 10})
    tokens = calls.Tokens(10, 10, None, None, None, "server")
    none = calls.Pricing(None, None, None, None, None)
    assert calls.cost_of(figures, tokens, none, outcome="whole", local=True) == (
        None, None, "none")


def test_a_typed_price_wins_and_one_half_prices_nothing():
    both = model(price_in=1.0, price_out=2.0, price_own_in=3.0, price_own_out=4.0,
                 price_cache_read=0.1, price_cache_write=1.25)
    assert calls.pricing_of(both) == calls.Pricing(3.0, 4.0, None, None, "typed")
    read = model(price_in=1.0, price_out=2.0, price_cache_read=0.1, price_cache_write=1.25)
    assert calls.pricing_of(read) == calls.Pricing(1.0, 2.0, 0.1, 1.25, "read")
    half = calls.pricing_of(model(price_own_in=3.0))
    assert half == calls.Pricing(None, None, None, None, None)
    tokens = calls.Tokens(1000, 100, None, None, None, "estimated")
    assert calls.cost_of(CallFigures(), tokens, half, outcome="whole", local=False) == (
        None, None, "none")


def test_at_home_is_a_local_family_at_a_private_address_with_no_price():
    assert calls.at_home(MODEL, service("http://127.0.0.1:11434/v1", "ollama")) == (True, True)
    assert calls.at_home(MODEL, service("http://192.168.1.5:11434/v1", "ollama")) == (
        True, False)
    typed = model(price_own_in=0.5, price_own_out=0.5)
    assert calls.at_home(typed, service("http://127.0.0.1:11434/v1", "ollama"))[0] is False
    assert calls.at_home(MODEL, service("http://localhost:8099/v1", "generic")) == (False, True)
    assert calls.at_home(MODEL, service("https://my-rented-box.example.com", "ollama")) == (
        False, False)


def test_instants_sort_as_text():
    first = datetime(2026, 11, 25, 23, 59, 59, 999000, tzinfo=UTC)
    later = first + timedelta(milliseconds=1)
    texts = [calls.instant(later), calls.instant(first)]
    assert sorted(texts) == [calls.instant(first), calls.instant(later)]
    for text in texts + [calls.instant()]:
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00", text), text


# The row, against a test database.

async def test_a_row_exists_before_the_first_word(database):
    go = asyncio.Event()
    provider = serve(lambda request: httpx.Response(200, stream=Waits(go)))

    async def call():
        async with calls.recording(provider, (MODEL, SERVICE), WHO, prompt_estimate=730):
            return await complete_answer(provider, PAYLOAD)

    calling = asyncio.create_task(call())
    while not provider.figures.sent:
        await within(2, asyncio.sleep(0.01))
    [row] = rows()
    assert (row["outcome"], row["tokens_in"], row["ended_at"]) == ("running", 730, None)
    assert (row["purpose"], row["conversation_title"], row["card_name"], row["card_kind"]) == (
        "reply", "At the inn", "Serana", "character")
    assert (row["model_id"], row["model_name"], row["service_id"], row["service_name"]) == (
        "ai-1", "Aurore", "svc-1", "OpenRouter")
    assert (row["family"], row["local"], row["loopback"]) == ("openrouter", 0, 0)
    assert (row["model_asked"], row["currency"], row["attempt"]) == ("test-model", "USD", 0)
    go.set()
    answer = await within(2, calling)
    assert answer.text == "Hi."
    [row] = rows()
    assert row["outcome"] == "whole"
    assert row["ended_at"] > row["started_at"] or row["ended_at"] == row["started_at"]


async def test_the_generation_id_is_written_as_soon_as_it_comes(database):
    provider = serve(lambda request: httpx.Response(200, stream=Held()))
    came: list = []
    reading = await read_until_two_pieces(provider, came)
    await calls.drain()
    [row] = rows()
    assert (row["outcome"], row["generation_id"], row["model_served"]) == (
        "running", "gen-1", "aurore/aurore-large")
    reading.cancel()
    with pytest.raises(asyncio.CancelledError):
        await reading


async def test_a_cancel_is_written_stopped_on_its_own_connection(database, monkeypatch):
    ended: list[dict] = []
    monkeypatch.setattr(calls, "_after_end", ended.append)
    # The caller's own connection, open around the call but holding no write: a recording is
    # never opened inside a write_transaction, whose BEGIN IMMEDIATE would hold its write 30 s.
    callers = await db._connect()
    try:
        await callers.execute_fetchall("SELECT COUNT(*) FROM calls")
        provider = serve(lambda request: httpx.Response(200, stream=Held()))
        reading = await read_until_two_pieces(provider, [])
        reading.cancel()
        with pytest.raises(asyncio.CancelledError):
            await reading
        [row] = rows()
        assert row["outcome"] == "stopped"
        assert row["tokens_out"] == calls.estimated_out(len("*She waits")) > 0
        assert (row["tokens_in"], row["tokens_source"]) == (400, "estimated")
        assert (row["generation_id"], row["upstream"]) == ("gen-1", "Lumen")
        assert row["ended_at"] is not None
        await callers.rollback()
    finally:
        await callers.close()
    assert [r["outcome"] for r in rows()] == ["stopped"]
    assert [(r["id"], r["outcome"]) for r in ended] == [(row["id"], "stopped")]


async def test_an_unreachable_server_is_refused_with_no_status(database, monkeypatch):
    ended: list[dict] = []
    monkeypatch.setattr(calls, "_after_end", ended.append)

    def handler(request):
        raise httpx.ConnectError("nobody there", request=request)

    provider = serve(handler)
    with pytest.raises(ProviderError):
        async with calls.recording(provider, (MODEL, SERVICE), WHO, prompt_estimate=500):
            await complete_answer(provider, PAYLOAD)
    [row] = rows()
    assert (row["outcome"], row["status"], row["tokens_in"], row["tokens_out"]) == (
        "refused", None, 0, 0)
    assert (row["cost"], row["cost_source"]) == (0, "none")
    assert ended[0]["outcome"] == "refused"


async def test_a_refusal_keeps_its_status(database):
    provider = serve(lambda request: httpx.Response(429, json={"error": {"message": "Slow."}}))
    with pytest.raises(ProviderError):
        async with calls.recording(provider, (MODEL, SERVICE), WHO, prompt_estimate=500):
            await complete_answer(provider, PAYLOAD)
    [row] = rows()
    assert (row["outcome"], row["status"], row["cost"]) == ("refused", 429, 0)


async def test_a_whole_call_keeps_the_server_s_figures(database):
    usage = {"prompt_tokens": 1200, "completion_tokens": 340, "cost": 0.0021,
             "prompt_tokens_details": {"cached_tokens": 200}}

    def handler(request):
        lines = [json.dumps(chunk("Hello.")),
                 json.dumps({"id": "gen-1", "choices": [], "usage": usage}), "[DONE]"]
        return httpx.Response(200, content=sse(lines))

    provider = serve(handler)
    read = model(price_in=1.0, price_out=2.0, price_cache_read=0.25)
    async with calls.recording(provider, (read, SERVICE), WHO, attempt=1,
                               prompt_estimate=900):
        await complete_answer(provider, PAYLOAD)
    [row] = rows()
    assert (row["outcome"], row["attempt"], row["tokens_in"], row["tokens_out"]) == (
        "whole", 1, 1200, 340)
    assert (row["tokens_cached"], row["tokens_source"]) == (200, "server")
    assert (row["cost"], row["cost_source"], row["cost_upstream"]) == (0.0021, "reported", None)
    assert (row["price_in"], row["price_out"], row["price_cache_read"], row["price_source"]) == (
        1.0, 2.0, 0.25, "read")
    assert json.loads(row["usage_raw"]) == usage
    assert provider.figures.on_id is None


async def test_a_discarded_answer_is_marked_on_its_row(database):
    provider = serve(lambda request: httpx.Response(
        200, content=sse([json.dumps(chunk("Not JSON.")), "[DONE]"])))
    async with calls.recording(provider, (MODEL, SERVICE), WHO, prompt_estimate=10) as kept:
        await complete_answer(provider, PAYLOAD)
        kept.mark("discarded")
    assert [r["outcome"] for r in rows()] == ["discarded"]
    async with calls.recording(provider, (MODEL, SERVICE), WHO, prompt_estimate=10) as later:
        await complete_answer(provider, PAYLOAD)
    await calls.discard(later.row_id)
    await calls.discard(None)
    assert [r["outcome"] for r in rows()] == ["discarded", "discarded"]


async def test_recording_never_breaks_a_call(database, monkeypatch, caplog):
    async def broken():
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(calls, "_connect", broken)
    provider = serve(lambda request: httpx.Response(
        200, content=sse([json.dumps(chunk("Still here.")), "[DONE]"])))
    with caplog.at_level(logging.WARNING, logger="app.services.calls"):
        async with calls.recording(provider, (MODEL, SERVICE), WHO, prompt_estimate=10) as kept:
            answer = await complete_answer(provider, PAYLOAD)
        await calls.discard("some-row")
        await calls.after_start()
    assert answer.text == "Still here."
    assert kept.row_id is None
    assert any(r.levelno == logging.WARNING for r in caplog.records)
    assert rows() == []


async def test_rows_left_running_become_stopped_at_start(database):
    conn = sqlite3.connect(db_path())
    try:
        for row_id in ("a", "b"):
            conn.execute(
                "INSERT INTO calls (id, started_at, purpose, outcome, tokens_in, tokens_out,"
                " tokens_source) VALUES (?, ?, 'reply', 'running', 300, 5, 'mixed')",
                (row_id, calls.instant()))
        conn.execute("INSERT INTO calls (id, started_at, purpose, outcome, tokens_in, tokens_out,"
                     " tokens_source) VALUES ('c', ?, 'reply', 'whole', 300, 5, 'server')",
                     (calls.instant(),))
        conn.commit()
    finally:
        conn.close()
    await calls.after_start()
    found = {r["id"]: (r["outcome"], r["tokens_in"], r["tokens_out"], r["tokens_source"])
             for r in rows()}
    assert found == {"a": ("stopped", 300, 0, "estimated"),
                     "b": ("stopped", 300, 0, "estimated"),
                     "c": ("whole", 300, 5, "server")}


async def test_the_server_s_start_stops_what_a_process_left_running(database, monkeypatch):
    from app.main import lifespan

    monkeypatch.setattr("app.services.memory_service.fill_vectors", _nothing)
    conn = sqlite3.connect(db_path())
    try:
        conn.execute("INSERT INTO calls (id, started_at, purpose, outcome, tokens_in)"
                     " VALUES ('left', ?, 'reply', 'running', 300)", (calls.instant(),))
        conn.commit()
    finally:
        conn.close()
    async with lifespan(None):
        assert [(r["outcome"], r["tokens_in"]) for r in rows()] == [("stopped", 300)]


async def _nothing() -> None:
    pass
