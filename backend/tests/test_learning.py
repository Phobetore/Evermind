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


# The pure rules.


def test_the_counts_are_read_from_either_shape():
    assert learning.counts_of({"prompt_tokens": 900, "completion_tokens": 40}) == (900, 40)
    assert learning.counts_of({"input_tokens": 10, "cache_read_input_tokens": 800,
                               "cache_creation_input_tokens": 90, "output_tokens": 7}) == (900, 7)
    assert learning.counts_of({"prompt_tokens": 900}) == (900, None)
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
    assert learning.too_long_figures(OPENAI_TOO_LONG) == (8192, 9500)
    assert learning.too_long_figures(ANTHROPIC_TOO_LONG) == (200000, 205000)
    assert learning.too_long_figures(LLAMA_TOO_LONG) == (4096, None)
    assert learning.too_long_figures(NO_FIGURES) == (None, None)
    for message in (OPENAI_TOO_LONG, ANTHROPIC_TOO_LONG, LLAMA_TOO_LONG, NO_FIGURES):
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
    assert 0.5 < 9500 / estimates[0] < 2.0
    assert row["token_ratio"] == pytest.approx(9500 / estimates[0])
    assert row["token_ratio_n"] == 1
    assert (await last_reply(client, convo))["content"] == "*She nods.*"


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
