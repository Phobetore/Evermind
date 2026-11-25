"""What a whole reply teaches Evermind of its AI: the server's count against the engine's estimate,
the length of its replies and of its thinking, a story the server read only from its end, and a
refusal for a prompt too long, learned and asked again once."""

import asyncio
import json
from typing import ClassVar

import pytest

from app.providers.base import CallFigures, ProviderError, ProviderEvent
from app.services import ai_call, learning, turns

from .conftest import messages_of, send
from .helpers import add_model
from .test_memory_room import chunk, finish, writing
from .test_my_ais_api import HOSTED, Model, conversation_on, open_db

# shape unverified: the three refusals are written from the servers' documentation, not read
# from a server.
OPENAI_TOO_LONG = ("This model's maximum context length is 8192 tokens. However, you requested "
                   "9500 tokens (8476 in the messages, 1024 in the completion). Please reduce the "
                   "length of the messages or completion.")
OPENAI_TOO_LONG_BARE = ("This model's maximum context length is 8192 tokens. However, you "
                        "requested 9500 tokens. Please reduce the length of the messages.")
# shape unverified: OpenRouter's, as it is remembered.
OPENROUTER_TOO_LONG = ("This endpoint's maximum context length is 163840 tokens. However, you "
                       "requested about 170000 tokens (168000 of text input, 2000 in the output). "
                       "Please reduce the length of either one, or use the \"middle-out\" "
                       "transform to compress your prompt automatically.")
ANTHROPIC_TOO_LONG = "prompt is too long: 205000 tokens > 200000 maximum"
LLAMA_TOO_LONG = "the request exceeds the available context size (4096 tokens), try increasing it"
NO_FIGURES = "The input is too long for this model's context window."


def counted(prompt, completion=40) -> str:
    """The last piece of a stream that says what the server counted."""
    usage = {"prompt_tokens": prompt, "completion_tokens": completion}
    return json.dumps({"choices": [], "usage": {k: v for k, v in usage.items() if v is not None}})


def answer(text: str, *, usage: dict | None = None, thinking: str = "") -> list[str]:
    lines = [chunk(reasoning_content=thinking)] if thinking else []
    lines += [chunk(content=text), finish("stop")]
    if usage is not None:
        lines.append(json.dumps({"choices": [], "usage": usage}))
    return [*lines, "[DONE]"]


async def no_memory_pass(client) -> None:
    resp = await client.put("/api/settings", json={"auto_memory": False})
    assert resp.status_code == 200, resp.text


async def row_of(ai_id: str) -> dict:
    """The AI as stored: what the API does not show yet is read in the database."""
    conn = await open_db()
    try:
        row = await (await conn.execute("SELECT * FROM models WHERE id = ?", (ai_id,))).fetchone()
        return dict(row)
    finally:
        await conn.close()


async def long_story(convo_id: str, count: int, characters: int) -> None:
    """``count`` messages of ``characters`` each after the greeting, by SQL."""
    conn = await open_db()
    try:
        row = await (await conn.execute(
            "SELECT COALESCE(MAX(position), -1) AS p FROM messages WHERE conversation_id = ?",
            (convo_id,))).fetchone()
        start = row["p"] + 1
        for n in range(count):
            role = "user" if (start + n) % 2 else "assistant"
            text = (f"Line {start + n}. " + "The rain goes on. " * characters)[:characters]
            await conn.execute(
                "INSERT INTO messages (id, conversation_id, role, variants, position, meta,"
                " created_at) VALUES (?, ?, ?, ?, ?, '{}', '2026-11-01T10:00:00+00:00')",
                (f"{convo_id}-{start + n}", convo_id, role, json.dumps([text]), start + n))
        await conn.commit()
    finally:
        await conn.close()


async def a_story(client, **fields) -> tuple[dict, dict]:
    await no_memory_pass(client)
    ai = await add_model(client, base_url=HOSTED, **fields)
    return ai, await conversation_on(client, ai["id"])


async def last_reply(client, convo: dict) -> dict:
    return (await messages_of(client, convo["id"]))[-1]


class Counting:
    """A model's server that counts what it reads as ``times`` the engine's estimate, and keeps
    each (prompt, estimate) and each call."""

    times = 1.2
    seen: ClassVar[list] = []
    calls: ClassVar[list] = []

    def __init__(self, call):
        Counting.calls.append(call)
        self.figures = CallFigures()

    async def stream_chat(self, payload):
        self.figures.reset()
        estimate = payload.stats["used_tokens"]
        prompt = round(Counting.times * estimate)
        Counting.seen.append((prompt, estimate))
        self.figures.take_usage({"prompt_tokens": prompt, "completion_tokens": 40}, final=True)
        yield ProviderEvent(type="delta", text="*She nods.*")
        yield ProviderEvent(type="done", stop="stop")


@pytest.fixture()
def counting(monkeypatch):
    Counting.seen, Counting.calls = [], []
    monkeypatch.setattr("app.services.chat_service.get_provider", Counting)
    return Counting


class Reading:
    """A model's server that reads the next of ``counts`` whatever it is sent, as one that drops
    the beginning of a story longer than it loads; keeps each (prompt, estimate)."""

    counts: ClassVar[list[int]] = []
    seen: ClassVar[list] = []
    during: ClassVar = None  # what happens on the server while it writes

    def __init__(self, call):
        self.call = call
        self.figures = CallFigures()

    async def stream_chat(self, payload):
        self.figures.reset()
        prompt = Reading.counts[min(len(Reading.seen), len(Reading.counts) - 1)]
        Reading.seen.append((prompt, payload.stats["used_tokens"]))
        if Reading.during is not None:
            await Reading.during(self.call)
        self.figures.take_usage({"prompt_tokens": prompt, "completion_tokens": 40}, final=True)
        yield ProviderEvent(type="delta", text="*She nods.*")
        yield ProviderEvent(type="done", stop="stop")


@pytest.fixture()
def reading(monkeypatch):
    Reading.counts, Reading.seen, Reading.during = [], [], None
    monkeypatch.setattr("app.services.chat_service.get_provider", Reading)
    return Reading


async def grown(convo_id: str) -> None:
    """Two more long messages: the story the engine estimates grows by about 750 tokens."""
    await long_story(convo_id, 2, 1300)


# The pure rules.


def test_the_counts_are_read_from_either_shape():
    assert learning.counts_of({"prompt_tokens": 900, "completion_tokens": 40}) == (900, 40)
    assert learning.counts_of({"input_tokens": 10, "cache_read_input_tokens": 800,
                               "cache_creation_input_tokens": 90, "output_tokens": 7}) == (900, 7)
    assert learning.counts_of({"prompt_tokens": 900}) == (900, None)
    assert learning.counts_of({"prompt_tokens": 900, "completion_tokens": -3}) == (900, None)
    assert learning.counts_of({"input_tokens": 900, "output_tokens": -1}) == (900, None)
    for wrong in ({"prompt_tokens": 0}, {"prompt_tokens": -5}, {"prompt_tokens": "12"},
                  {"completion_tokens": 10}, {"prompt_tokens": True}, {}):
        assert learning.counts_of(wrong) is None, wrong


def test_truncation_needs_a_round_size_or_a_plateau():
    model = {"context_read": None, "context_read_kind": None}

    def cut(prompt, estimate, earlier=()):
        return learning.truncated(prompt=prompt, estimate=estimate, ratio=1.0, model=model,
                                  earlier=list(earlier))

    assert cut(4090, 9000)            # within 2 % under 4096
    assert not cut(3000, 9000)        # neither round nor a plateau
    assert not cut(4090, 5000)        # above 0.7 of the estimate
    # Three turns whose estimate grows from 8000 to 9000 while the count stands still.
    assert not cut(3000, 8000)
    assert not cut(3010, 8500, [(3000, 8000)])
    assert cut(3020, 9000, [(3000, 8000), (3010, 8500)])
    # A count that stands still while the story does too is a story that did not grow.
    assert not cut(3020, 8000, [(3000, 8000), (3010, 8000)])
    assert not cut(3020, 8400, [(3000, 8000), (3010, 8200)])
    # A size the server is set to load counts as round.
    assert learning.truncated(prompt=6000, estimate=12000, ratio=1.0, earlier=[],
                              model={"context_read": 6100, "context_read_kind": "configured"})
    assert not learning.truncated(prompt=6000, estimate=12000, ratio=1.0, earlier=[],
                                  model={"context_read": 6100, "context_read_kind": "served"})
    # The estimate is corrected by the ratio measured before it is compared.
    assert not learning.truncated(prompt=4090, estimate=9000, ratio=0.6, model=model, earlier=[])


def test_the_ratio_is_kept_between_half_and_double():
    assert learning.next_ratio({}, 10.0) == (2.0, 1)
    assert learning.next_ratio({}, 0.1) == (0.5, 1)
    assert learning.next_ratio({"token_ratio": 1.0, "token_ratio_n": 1}, 10.0) == (1.5, 2)


def test_the_average_is_over_the_last_eight():
    ratio, n = learning.next_ratio({"token_ratio": 1.0, "token_ratio_n": 20}, 1.8)
    assert (ratio, n) == (pytest.approx(1.1), 21)


def test_the_three_refusal_forms_are_read():
    # What was requested holds the reply's room: the prompt is the messages' part of it, or what
    # is left once the max_tokens sent is taken away.
    assert learning.too_long_figures(OPENAI_TOO_LONG, sent=1024) == (8192, 8476)
    assert learning.too_long_figures(OPENAI_TOO_LONG) == (8192, 8476)
    assert learning.too_long_figures(OPENAI_TOO_LONG_BARE, sent=1024) == (8192, 8476)
    assert learning.too_long_figures(OPENAI_TOO_LONG_BARE) == (8192, 9500)
    assert learning.too_long_figures(OPENROUTER_TOO_LONG, sent=2000) == (163840, 168000)
    assert learning.too_long_figures(ANTHROPIC_TOO_LONG, sent=4096) == (200000, 205000)
    assert learning.too_long_figures(LLAMA_TOO_LONG, sent=1024) == (4096, None)
    assert learning.too_long_figures(NO_FIGURES) == (None, None)
    for message in (OPENAI_TOO_LONG, OPENAI_TOO_LONG_BARE, OPENROUTER_TOO_LONG,
                    ANTHROPIC_TOO_LONG, LLAMA_TOO_LONG, NO_FIGURES):
        assert learning.is_too_long(ProviderError(message, status=400)), message
        assert not learning.is_too_long(ProviderError(message, status=500)), message
    assert learning.is_too_long(ProviderError(ANTHROPIC_TOO_LONG, status=413))
    for other in ("Unrecognized request argument supplied: stream_options",
                  "Invalid API key", "max_tokens must be at least 1"):
        assert not learning.is_too_long(ProviderError(other, status=400)), other
    assert not learning.is_too_long(None)


def test_the_thinking_allowance_is_measured_once_there_is_one():
    assert ai_call.thinking_allowance({}) == ai_call.THINKING_ALLOWANCE
    assert ai_call.thinking_allowance({"reply_tokens_avg": "not json"}) == 3072
    measured = json.dumps({"thinking": {"avg": 1495.6, "n": 1}})
    assert ai_call.thinking_allowance({"reply_tokens_avg": measured}) == 1496
    none_yet = json.dumps({"thinking": {"avg": 900.0, "n": 0}})
    assert ai_call.thinking_allowance({"reply_tokens_avg": none_yet}) == 3072


# Through turns.


async def test_the_ratio_moves_towards_what_the_server_counts(client, counting):
    ai, convo = await a_story(client)
    for _ in range(3):
        assert await send(client, convo["id"]) is None

    row = await row_of(ai["id"])
    samples = [prompt / estimate for prompt, estimate in counting.seen]
    by_hand = samples[0]
    for n, sample in enumerate(samples[1:], start=2):
        by_hand += (sample - by_hand) / n
    assert row["token_ratio"] == pytest.approx(by_hand, abs=1e-9)
    assert row["token_ratio"] == pytest.approx(1.2, abs=0.01)
    assert row["token_ratio_n"] == 3
    assert row["usage_seen"] == 1
    usage = (await last_reply(client, convo))["meta"]["usage"]
    assert usage == {"prompt": counting.seen[-1][0], "completion": 40, "model_id": ai["id"]}

    assert await send(client, convo["id"]) is None
    assert counting.calls[-1]["margin"] == max(200, int(16384 * 0.03))
    assert counting.calls[-1]["token_ratio"] == pytest.approx(by_hand)


async def test_counts_that_cannot_be_right_teach_nothing(client, monkeypatch):
    ai, convo = await a_story(client)
    Model(*(answer("*She nods.*", usage=usage) for usage in (
        {"prompt_tokens": 0, "completion_tokens": 9}, {"prompt_tokens": -5},
        {"prompt_tokens": "12"}, {"completion_tokens": 10}))).serve(monkeypatch)
    for _ in range(4):
        assert await send(client, convo["id"]) is None
        row = await row_of(ai["id"])
        assert (row["usage_seen"], row["token_ratio"], row["token_ratio_n"],
                row["reply_tokens_avg"], row["fit_margin"]) == (0, None, 0, None, None)
        assert "usage" not in (await last_reply(client, convo))["meta"]


async def test_a_server_that_says_nothing_keeps_the_wide_margin_and_says_so(client, monkeypatch):
    ai, convo = await a_story(client)
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    row = await row_of(ai["id"])
    assert (row["usage_seen"], row["token_ratio"]) == (0, None)

    assert await send(client, convo["id"]) is None
    assert model.calls[-1]["margin"] == int(16384 * 0.06)
    assert model.calls[-1]["token_ratio"] is None


async def test_a_truncated_reply_says_so_and_feeds_nothing(client, monkeypatch):
    ai, convo = await a_story(client)
    await long_story(convo["id"], 22, 1300)
    Model(answer("*She nods.*", usage={"prompt_tokens": 4090, "completion_tokens": 30})
          ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None

    reply = await last_reply(client, convo)
    assert reply["meta"]["context"]["used_tokens"] > 4090 / 0.7
    assert reply["meta"]["truncated"] == {"read": 4090, "window": 16384}
    assert reply["meta"]["usage"]["prompt"] == 4090
    row = await row_of(ai["id"])
    assert (row["token_ratio"], row["token_ratio_n"], row["usage_seen"]) == (None, 0, 1)


async def test_a_story_read_only_from_its_end_is_seen_on_the_third_turn(client, reading):
    ai, convo = await a_story(client)
    await long_story(convo["id"], 12, 1300)
    reading.counts = [3005, 3010, 3015]
    for turn in range(3):
        if turn:
            await grown(convo["id"])
        assert await send(client, convo["id"]) is None
        meta = (await last_reply(client, convo))["meta"]
        assert ("truncated" in meta) == (turn == 2), (turn, meta)
        assert meta["usage"]["prompt"] == reading.counts[turn]
        row = await row_of(ai["id"])
        # Read far under the estimate, no reply teaches a ratio, though none is proved cut yet.
        assert (row["token_ratio"], row["token_ratio_n"], row["usage_seen"]) == (None, 0, 1)

    first, last = reading.seen[0][1], reading.seen[-1][1]
    assert last > first * 1.05 and all(p < 0.7 * e for p, e in reading.seen)
    assert meta["truncated"] == {"read": 3015, "window": 16384}


async def test_a_new_version_is_not_one_of_the_counts_before_it(client, reading):
    _, convo = await a_story(client)
    await long_story(convo["id"], 12, 1300)
    reading.counts = [3000, 3010, 3020]
    assert await send(client, convo["id"]) is None
    await grown(convo["id"])
    assert await send(client, convo["id"]) is None

    # The version rewritten would make the third point of a plateau with the reply before it.
    assert await send(client, convo["id"], mode="regenerate") is None
    assert reading.seen[-1][1] > reading.seen[0][1] * 1.05
    assert "truncated" not in (await last_reply(client, convo))["meta"]


async def test_another_ais_counts_are_not_this_ones(client, reading):
    _, convo = await a_story(client)
    await long_story(convo["id"], 12, 1300)
    reading.counts = [3000, 3010, 3020]
    for turn in range(2):
        if turn:
            await grown(convo["id"])
        assert await send(client, convo["id"]) is None

    other = await add_model(client, base_url=HOSTED, model="other")
    resp = await client.patch(f"/api/conversations/{convo['id']}", json={"model_id": other["id"]})
    assert resp.status_code == 200, resp.text
    await grown(convo["id"])
    assert await send(client, convo["id"]) is None
    assert reading.seen[-1][1] > reading.seen[0][1] * 1.05
    meta = (await last_reply(client, convo))["meta"]
    assert meta["usage"]["model_id"] == other["id"] and "truncated" not in meta


async def test_a_new_version_does_not_keep_the_truncation_of_the_one_before(client, monkeypatch):
    _, convo = await a_story(client)
    await long_story(convo["id"], 22, 1300)
    model = Model(answer("*She nods.*", usage={"prompt_tokens": 4090})).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    assert "truncated" in (await last_reply(client, convo))["meta"]

    model.answers = [writing("*She shrugs.*")]
    assert await send(client, convo["id"], mode="regenerate") is None
    meta = (await last_reply(client, convo))["meta"]
    assert "truncated" not in meta and "usage" not in meta


async def test_reduce_and_try_again_records_what_was_observed(client, monkeypatch):
    ai, convo = await a_story(client)
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None

    resp = await client.post(f"/api/models/{ai['id']}/observed", json={"tokens": 4096})
    assert resp.status_code == 200, resp.text
    context = resp.json()["context"]
    assert (context["read"], context["read_kind"], context["own"]) == (4096, "observed", None)
    assert context["used"] == 4096

    assert await send(client, convo["id"], mode="regenerate") is None
    assert model.calls[-1]["context_size"] == 4096
    assert (await last_reply(client, convo))["meta"]["context"]["context_size"] == 4096


async def test_what_was_observed_is_refused_below_the_floor_or_on_no_ai(client):
    ai = await add_model(client, base_url=HOSTED)
    for wrong in ({"tokens": 511}, {"tokens": "4096"}, {}):
        resp = await client.post(f"/api/models/{ai['id']}/observed", json=wrong)
        assert resp.status_code == 422, wrong
    resp = await client.post("/api/models/nope/observed", json={"tokens": 4096})
    assert resp.status_code == 404


async def test_an_own_size_under_what_was_observed_is_kept(client):
    ai = await add_model(client, base_url=HOSTED, context_own=2048)
    resp = await client.post(f"/api/models/{ai['id']}/observed", json={"tokens": 4096})
    assert resp.json()["context"]["own"] == 2048


async def test_a_too_long_refusal_with_both_figures_is_learned_and_asked_again_once(
        client, monkeypatch):
    ai, convo = await a_story(client, context_own=None)
    await long_story(convo["id"], 22, 1000)
    estimates = []
    learn = learning.after_too_long

    async def spied(db, call, model, *, message, estimate):
        estimates.append(estimate)
        await learn(db, call, model, message=message, estimate=estimate)

    monkeypatch.setattr(learning, "after_too_long", spied)
    model = Model((400, {"error": {"message": OPENAI_TOO_LONG}}), writing("*She nods.*")
                  ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None

    assert len(model.bodies) == 2
    assert [call["context_size"] for call in model.calls] == [16384, 8192]
    row = await row_of(ai["id"])
    assert (row["context_read"], row["context_read_kind"], row["context_own"]) == (
        8192, "served", None)
    # The messages' part of what was requested, the reply's room left out.
    assert 0.5 < 8476 / estimates[0] < 2.0
    assert row["token_ratio"] == pytest.approx(8476 / estimates[0])
    assert row["token_ratio_n"] == 1
    assert (await last_reply(client, convo))["content"] == "*She nods.*"


async def set_row(ai_id: str, **columns) -> None:
    conn = await open_db()
    try:
        await conn.execute(f"UPDATE models SET {', '.join(f'{k} = ?' for k in columns)}"
                           " WHERE id = ?", (*columns.values(), ai_id))
        await conn.commit()
    finally:
        await conn.close()


def spy_on_refusals(monkeypatch) -> list[int]:
    """The estimate of each prompt refused as too long."""
    estimates = []
    learn = learning.after_too_long

    async def spied(db, call, model, *, message, estimate):
        estimates.append(estimate)
        await learn(db, call, model, message=message, estimate=estimate)

    monkeypatch.setattr(learning, "after_too_long", spied)
    return estimates


async def test_a_refusal_without_the_messages_part_leaves_out_what_was_sent_for_the_reply(
        client, monkeypatch):
    ai, convo = await a_story(client, context_own=None, reply_cap={"mode": "auto"})
    await long_story(convo["id"], 22, 1000)
    estimates = spy_on_refusals(monkeypatch)
    model = Model((400, {"error": {"message": OPENAI_TOO_LONG_BARE}}), writing("*She nods.*")
                  ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None

    sent = model.bodies[0]["max_tokens"]
    assert sent == model.calls[0]["max_tokens"] > 0
    row = await row_of(ai["id"])
    assert row["token_ratio"] == pytest.approx((9500 - sent) / estimates[0])


async def test_a_refusal_moves_the_ratio_measured_and_is_kept_between_half_and_double(
        client, monkeypatch):
    ai, convo = await a_story(client, context_own=None)
    await long_story(convo["id"], 22, 1000)
    await set_row(ai["id"], token_ratio=1.2, token_ratio_n=3)
    estimates = spy_on_refusals(monkeypatch)
    model = Model((400, {"error": {"message": OPENAI_TOO_LONG}}), writing("*She nods.*")
                  ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    row = await row_of(ai["id"])
    sample = 8476 / estimates[0]
    assert 0.5 < sample < 2.0
    assert (row["token_ratio"], row["token_ratio_n"]) == (
        pytest.approx(1.2 + (sample - 1.2) / 4), 4)

    # A count ten times the estimate is kept at double.
    other, story = await a_story(client, context_own=None, model="second")
    estimates.clear()
    model.answers, model.bodies = [(400, {"error": {"message": (
        "This model's maximum context length is 8192 tokens. However, you requested 900000 "
        "tokens (899000 in the messages, 1000 in the completion).")}}), writing("*She nods.*")], []
    assert await send(client, story["id"]) is None
    assert 899000 / estimates[0] > 10
    row = await row_of(other["id"])
    assert (row["token_ratio"], row["token_ratio_n"]) == (2.0, 1)


async def test_a_refusal_with_both_figures_replaces_the_margin_it_widened(client, monkeypatch):
    ai, convo = await a_story(client, context_own=None)
    model = Model((400, {"error": {"message": NO_FIGURES}}), writing("*She nods.*")
                  ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    assert (await row_of(ai["id"]))["fit_margin"] == pytest.approx(0.10)

    model.answers, model.bodies = [(400, {"error": {"message": OPENAI_TOO_LONG}}),
                                   writing("*She nods.*")], []
    assert await send(client, convo["id"]) is None
    row = await row_of(ai["id"])
    assert (row["fit_margin"], row["token_ratio_n"]) == (None, 1)


async def test_a_refusal_naming_the_size_counted_widens_the_margin(client, monkeypatch):
    ai, convo = await a_story(client)
    same = LLAMA_TOO_LONG.replace("4096", "16384")
    model = Model((400, {"error": {"message": same}}), writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    assert model.calls[0]["context_size"] == 16384
    row = await row_of(ai["id"])
    assert (row["fit_margin"], row["context_read"], row["token_ratio"]) == (
        pytest.approx(0.10), None, None)


async def test_a_refusal_on_a_story_opening_on_the_greeting_does_not_fold_it(client, monkeypatch):
    _, convo = await a_story(client)
    model = Model((400, {"error": {"message": NO_FIGURES}}), writing("*She nods.*")
                  ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    first, again = (body["messages"] for body in model.bodies)
    assert first[1]["role"] == "assistant" and "She stirs" in first[1]["content"]
    assert again == first


async def test_a_too_long_refusal_without_figures_widens_the_margin(client, monkeypatch):
    ai, convo = await a_story(client)
    refusal = (400, {"error": {"message": NO_FIGURES}})
    model = Model().serve(monkeypatch)
    for widened in (0.10, 0.20, 0.30, 0.40, 0.40):
        model.answers, model.bodies = [refusal, writing("*She nods.*")], []
        assert await send(client, convo["id"]) is None
        assert (await row_of(ai["id"]))["fit_margin"] == pytest.approx(widened)
    assert model.calls[-1]["margin"] == int(16384 * 0.06) + int(0.40 * 16384)

    model.answers, model.bodies = [answer("*She nods.*", usage={"prompt_tokens": 5000})], []
    assert await send(client, convo["id"]) is None
    row = await row_of(ai["id"])
    assert (row["fit_margin"], row["token_ratio_n"]) == (None, 1)


async def test_a_second_refusal_ends_the_turn_saying_so(client, monkeypatch):
    _, convo = await a_story(client)
    before = len(await messages_of(client, convo["id"]))
    model = Model((400, {"error": {"message": NO_FIGURES}})).serve(monkeypatch)
    outcome = await send(client, convo["id"])

    assert outcome["kind"] == "model_too_long"
    assert outcome["message"] == NO_FIGURES
    assert len(model.bodies) == 2
    messages = await messages_of(client, convo["id"])
    assert len(messages) == before + 1 and messages[-1]["role"] == "user"
    assert messages[-1]["meta"]["unanswered"]["kind"] == "model_too_long"


async def test_another_refusal_is_not_asked_again(client, monkeypatch):
    ai, convo = await a_story(client)
    model = Model((400, {"error": {"message": "Invalid model parameters."}})).serve(monkeypatch)
    outcome = await send(client, convo["id"])
    assert outcome["kind"] == "model_error" and len(model.bodies) == 1
    assert (await row_of(ai["id"]))["fit_margin"] is None


class UsageThenLingers:
    """A reply whose count has come, then nothing more until it is stopped."""

    arrived: asyncio.Event

    def __init__(self, call):
        self.figures = CallFigures()

    async def stream_chat(self, payload):
        self.figures.take_usage({"prompt_tokens": 900, "completion_tokens": 40}, final=True)
        yield ProviderEvent(type="delta", text="She opens")
        UsageThenLingers.arrived.set()
        await asyncio.sleep(60)


async def test_a_stopped_or_failed_reply_teaches_nothing(client, monkeypatch):
    from app.models.schemas import ChatRequest

    ai, convo = await a_story(client)
    untouched = await row_of(ai["id"])

    UsageThenLingers.arrived = asyncio.Event()
    monkeypatch.setattr("app.services.chat_service.get_provider", UsageThenLingers)
    turn = await turns.start(ChatRequest(conversation_id=convo["id"], mode="send",
                                         content="Go on", client_id="stopped"))
    await asyncio.wait_for(UsageThenLingers.arrived.wait(), timeout=10)
    await turns.stop(convo["id"])
    await asyncio.wait_for(turn.finished.wait(), timeout=15)
    assert await row_of(ai["id"]) == untouched
    assert "usage" not in (await last_reply(client, convo))["meta"]

    Model([chunk(content="She"), counted(900), json.dumps({"error": {"message": "boom"}})]
          ).serve(monkeypatch)
    outcome = await send(client, convo["id"])
    assert outcome["kind"] == "model_error"
    assert await row_of(ai["id"]) == untouched


async def test_the_reply_length_and_the_thinking_are_measured(client, monkeypatch):
    ai, convo = await a_story(client, read={"reasons": True}, reply_cap={"mode": "auto"})
    assert (await row_of(ai["id"]))["reasons"] == 1
    Model(answer("*She nods.*", thinking="Hmm. " * 10,
                 usage={"prompt_tokens": 5000, "completion_tokens": 1500})).serve(monkeypatch)
    for _ in range(3):
        assert await send(client, convo["id"]) is None

    averages = json.loads((await row_of(ai["id"]))["reply_tokens_avg"])
    thinking = 1500 - (int(len("*She nods.*") / 3.5) + 1)
    assert averages["medium"] == {"avg": pytest.approx(1500), "n": 3}
    assert averages["thinking"] == {"avg": pytest.approx(thinking), "n": 3}

    assert await send(client, convo["id"]) is None
    context = (await last_reply(client, convo))["meta"]["context"]
    assert context["reply_room"] == 1024 + thinking


async def test_a_reply_cut_at_its_ceiling_teaches_no_length(client, monkeypatch):
    ai, convo = await a_story(client)
    Model([chunk(content="She opens"), finish("length"), counted(5000, 1024), "[DONE]"]
          ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    row = await row_of(ai["id"])
    assert row["token_ratio_n"] == 1
    assert "medium" not in json.loads(row["reply_tokens_avg"] or "{}")
