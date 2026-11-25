"""What a whole reply teaches Evermind of its AI: the server's count against the engine's estimate,
the length of its replies and of its thinking, a story the server read only from its end, and a
refusal for a prompt too long, learned and asked again once."""

import asyncio
import json
from typing import ClassVar

import pytest

from app.providers.base import CallFigures, ProviderError, ProviderEvent
from app.services import ai_call, learning, limits, turns

from .conftest import messages_of, send
from .helpers import add_model
from .test_memory_room import chunk, finish, writing
from .test_my_ais_api import HOSTED, Lists, Model, conversation_on, model_of, open_db

# The refusals of a prompt too long as servers word them (their figures changed): OpenAI's, which
# DeepSeek and vLLM's 0.6 also send.
OPENAI_TOO_LONG = ("This model's maximum context length is 8192 tokens. However, you requested "
                   "9500 tokens (8476 in the messages, 1024 in the completion). Please reduce the "
                   "length of the messages or completion.")
# Evermind's fake model's (scripts/mock_llm.py), no server's: what was requested, its parts
# untold.
OPENAI_TOO_LONG_BARE = ("This model's maximum context length is 8192 tokens. However, you "
                        "requested 9500 tokens. Please reduce the length of the messages.")
# OpenRouter's.
OPENROUTER_TOO_LONG = ("This endpoint's maximum context length is 131072 tokens. However, you "
                       "requested about 140000 tokens (130000 of text input, 10000 in the output). "
                       "Please reduce the length of either one, or use the \"middle-out\" "
                       "transform to compress your prompt automatically.")
# Anthropic's.
ANTHROPIC_TOO_LONG = "prompt is too long: 203073 tokens > 200000 maximum"
# llama.cpp's, today; its body also says n_prompt_tokens and n_ctx.
LLAMA_TOO_LONG = ("request (9000 tokens) exceeds the available context size (8192 tokens), try "
                  "increasing it")
# LM Studio's, before it took OpenAI's form: the size it loaded, and no count.
LMSTUDIO_TOO_LONG = (" Trying to keep the first 15857 tokens when context the overflows. However, "
                     "the model is loaded with context length of only 4096 tokens, which is not "
                     "enough. Try to load the model with a larger context length, or provide a "
                     "shorter input. Error Data: n/a, Additional Data: n/a")
# OpenAI's today, with code context_length_exceeded: no figure.
NO_FIGURES = ("Your input exceeds the context window of this model. Please adjust your input and "
              "try again.")

# Each as the server sends it (status, body), what is read of it, and the service it is from:
# (limit, prompt), with the max_tokens sent taken as 1024.
TOO_LONG_BODIES = [
    ("OpenAI, its reply's room too large", 400, {"error": {"message": (
        "This model's maximum context length is 8192 tokens. However, you requested 29973 tokens "
        "(68 in the messages, 29905 in the completion). Please reduce the length of the messages "
        "or completion."), "code": "context_length_exceeded"}}, (8192, 68)),
    ("OpenAI, its messages", 400, {"error": {"message": (
        "This model's maximum context length is 4097 tokens. However, your messages resulted in "
        "7403 tokens. Please reduce the length of the messages.")}}, (4097, 7403)),
    ("OpenAI, today", 400, {"error": {"message": NO_FIGURES, "code": "context_length_exceeded"}},
     (None, None)),
    ("OpenRouter", 400, {"error": {"message": OPENROUTER_TOO_LONG, "code": 400}}, (131072, 130000)),
    ("Anthropic, the prompt", 400, {"type": "error", "error": {
        "type": "invalid_request_error", "message": ANTHROPIC_TOO_LONG}}, (200000, 203073)),
    ("Anthropic, the prompt and its ceiling", 400, {"type": "error", "error": {
        "type": "invalid_request_error", "message": (
            "input length and `max_tokens` exceed context limit: 198882 + 21333 > 200000, "
            "decrease input length or `max_tokens` and try again")}}, (200000, 198882)),
    ("DeepSeek", 400, {"error": {"message": (
        "This model's maximum context length is 102400 tokens. However, you requested 107837 "
        "tokens (99645 in the messages, 8192 in the completion). Please reduce the length of the "
        "messages or completion."), "code": "invalid_request_error"}}, (102400, 99645)),
    ("Mistral", 400, {"object": "error", "message": (
        "Prompt contains 277504 tokens and 0 draft tokens, too large for model with 131072 "
        "maximum context length"), "type": "invalid_request_error"}, (131072, 277504)),
    ("Groq", 400, {"error": {"message": "Please reduce the length of the messages or completion.",
                             "code": "context_length_exceeded"}}, (None, None)),
    ("llama.cpp", 400, {"error": {"code": 400, "message": LLAMA_TOO_LONG,
                                  "type": "exceed_context_size_error", "n_prompt_tokens": 9000,
                                  "n_ctx": 8192}}, (8192, 9000)),
    ("llama.cpp, before", 400, {"error": {
        "code": 400, "message": "the request exceeds the available context size, try increasing it",
        "type": "exceed_context_size_error", "n_prompt_tokens": 9000, "n_ctx": 8192}}, (8192, 9000)),
    ("llama.cpp, before its figures", 400, {"error": {
        "code": 400, "message": "the request exceeds the available context size, try increasing it",
        "type": "exceed_context_size_error"}}, (None, None)),
    ("llama.cpp's server, input", 400, {"error": {"code": 400, "message": (
        "input (9000 tokens) is larger than the max context size (8192 tokens). skipping"),
        "type": "exceed_context_size_error"}}, (8192, 9000)),
    ("Ollama", 400, {"error": {"message": (
        "the prompt is longer than the context length currently available to the model; shorten "
        "the prompt, adjust the context length in settings, or use a model with a longer context "
        "length")}}, (None, None)),
    ("Ollama's service", 400, {"error": (
        "The prompt is too long: 297754, model maximum context length: 262144")}, (262144, 297754)),
    ("LM Studio, before", 400, {"error": LMSTUDIO_TOO_LONG}, (4096, None)),
    ("vLLM", 400, {"error": {"message": (
        "This model's maximum context length is 32768 tokens. However, your prompt contains 40000 "
        "input tokens, which exceeds this limit even without any output tokens. Please reduce the "
        "length of the input prompt."), "type": "BadRequestError", "code": 400}}, (32768, 40000)),
    ("vLLM, in characters", 400, {"error": {"message": (
        "This model's maximum context length is 32768 tokens. However, your prompt contains "
        "200000 characters (more than 131072 characters, which is the upper bound for 32768 input "
        "tokens). Please reduce the length of the input prompt."), "code": 400}}, (32768, None)),
    ("vLLM 0.11", 400, {"object": "error", "message": (
        "This model's maximum context length is 32768 tokens. However, your request has 40000 "
        "input tokens. Please reduce the length of the input messages."), "code": 400},
     (32768, 40000)),
    ("vLLM 0.6, the messages", 400, {"object": "error", "message": (
        "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens "
        "in the messages, Please reduce the length of the messages."), "code": 400},
     (32768, 40000)),
    ("vLLM 0.6", 400, {"object": "error", "message": (
        "This model's maximum context length is 32768 tokens. However, you requested 41024 tokens "
        "(40000 in the messages, 1024 in the completion). Please reduce the length of the messages "
        "or completion."), "code": 400}, (32768, 40000)),
    ("vLLM, its input", 400, {"error": {"message": (
        "Input length (40000) exceeds model's maximum context length (32768).")}}, (32768, 40000)),
]
# Refusals that are no prompt too long, whatever words they share with one.
NOT_TOO_LONG_BODIES = [
    ("OpenAI, a ceiling above the model's", 400, {"error": {"message": (
        "max_tokens is too large: 8000. This model supports at most 4096 completion tokens, "
        "whereas you provided 8000.")}}),
    ("Anthropic, a ceiling above the model's", 400, {"type": "error", "error": {
        "type": "invalid_request_error", "message": (
            "max_tokens: 10000 > 4096, which is the maximum allowed number of output tokens for "
            "claude-3-5-sonnet-20240620")}}),
    ("vLLM, a ceiling above what is left", 400, {"object": "error", "message": (
        "'max_tokens' or 'max_completion_tokens' is too large: 30000. This model's maximum context "
        "length is 32768 tokens and your request has 4000 input tokens (30000 > 32768 - 4000)."),
        "code": 400}),
    ("vLLM, a ceiling above the model's", 400, {"error": {"message": (
        "max_tokens=40000 cannot be greater than max_model_len=32768. Please request fewer output "
        "tokens."), "code": 400}}),
    ("Groq, tokens a minute", 413, {"error": {"message": (
        "Request too large for model `llama-3.1-8b-instant` in organization `xxxx` service tier "
        "`on_demand` on tokens per minute (TPM): Limit 6000, Requested 6294, please reduce your "
        "message size and try again. Visit https://console.groq.com/docs/rate-limits for more "
        "information."), "type": "tokens", "code": "rate_limit_exceeded"}}),
    ("a rate of tokens a minute", 400, {"error": {"message": (
        "Rate limit reached on tokens per minute: Limit 10000, Used 9000, Requested 4000 tokens."
        )}}),
    ("DeepSeek, a ceiling out of range", 400, {"error": {"message": (
        "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]")}}),
    ("OpenRouter, credits", 402, {"error": {"message": (
        "This request requires more credits, or fewer max_tokens. You requested up to 16000 "
        "tokens, but can only afford 15154.")}}),
    ("a parameter refused", 400, {"error": {"message": (
        "Unrecognized request argument supplied: context")}}),
]


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


async def a_long_story(client, **fields) -> tuple[dict, dict]:
    """A story longer than what its AI reads, whatever the margin: a shorter prompt drops more."""
    ai, convo = await a_story(client, **fields)
    await long_story(convo["id"], 30, 3000)
    return ai, convo


async def last_reply(client, convo: dict) -> dict:
    return (await messages_of(client, convo["id"]))[-1]


class Counting:
    """A model's server that counts what it reads as ``times`` the engine's estimate, and keeps
    each (prompt, estimate) and each call. ``at``, when set, is the count it gives instead."""

    times = 1.2
    at: ClassVar[int | None] = None
    seen: ClassVar[list] = []
    calls: ClassVar[list] = []

    def __init__(self, call):
        Counting.calls.append(call)
        self.figures = CallFigures()

    async def stream_chat(self, payload):
        self.figures.reset()
        estimate = payload.stats["used_tokens"]
        prompt = Counting.at or round(Counting.times * estimate)
        Counting.seen.append((prompt, estimate))
        self.figures.take_usage({"prompt_tokens": prompt, "completion_tokens": 40}, final=True)
        yield ProviderEvent(type="delta", text="*She nods.*")
        yield ProviderEvent(type="done", stop="stop")


@pytest.fixture()
def counting(monkeypatch):
    Counting.seen, Counting.calls, Counting.at = [], [], None
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
    # Two counts of this story that grew with it say what the server counts better than a ratio
    # stored before: one just under a round size at that rate is no cut.
    assert learning.truncated(prompt=8100, estimate=9500, ratio=1.4, model=model, earlier=[])
    grew = [(6800, 8000), (7480, 8800)]
    assert not learning.truncated(prompt=8100, estimate=9500, ratio=1.4, model=model,
                                  earlier=grew)
    # A count far under the rate they show is still a cut.
    assert learning.truncated(prompt=4090, estimate=9500, ratio=1.4, model=model, earlier=grew)
    # Counts that did not move with the estimate, or moved against it, prove nothing.
    for unproved in ([(7400, 8000), (7420, 8800)], [(7480, 8000), (6800, 8800)],
                     [(6800, 8000), (7480, 8200)], [(3000, 8000), (7480, 8800)]):
        assert learning.truncated(prompt=8100, estimate=9500, ratio=1.4, model=model,
                                  earlier=unproved), unproved
    # The rate they show is kept at double: just under 4096, a count far under the estimate at
    # 2.6 but not at 2.0 is no cut.
    above = [(5200, 2000), (5980, 2300)]
    assert 4090 < 0.7 * 2.6 * 2900 and not 4090 < 0.7 * 2.0 * 2900
    assert not learning.truncated(prompt=4090, estimate=2900, ratio=1.0, model=model,
                                  earlier=above)


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
    # Its parts need not add up to the whole: the text input is read, not what is left.
    assert learning.too_long_figures(OPENROUTER_TOO_LONG, sent=2000) == (131072, 130000)
    # A request no larger than the room it asked for the reply leaves no prompt to count.
    assert learning.too_long_figures(OPENAI_TOO_LONG_BARE, sent=9500) == (8192, 0)
    assert learning.too_long_figures(ANTHROPIC_TOO_LONG, sent=4096) == (200000, 203073)
    assert learning.too_long_figures(LLAMA_TOO_LONG, sent=1024) == (8192, 9000)
    assert learning.too_long_figures(LMSTUDIO_TOO_LONG, sent=1024) == (4096, None)
    assert learning.too_long_figures(NO_FIGURES) == (None, None)
    for message in (OPENAI_TOO_LONG, OPENAI_TOO_LONG_BARE, OPENROUTER_TOO_LONG,
                    ANTHROPIC_TOO_LONG, LLAMA_TOO_LONG, LMSTUDIO_TOO_LONG, NO_FIGURES):
        assert learning.is_too_long(ProviderError(message, status=400)), message
        assert not learning.is_too_long(ProviderError(message, status=500)), message
    assert learning.is_too_long(ProviderError(ANTHROPIC_TOO_LONG, status=413))
    for other in ("Unrecognized request argument supplied: stream_options",
                  "Invalid API key", "max_tokens must be at least 1"):
        assert not learning.is_too_long(ProviderError(other, status=400)), other
    assert not learning.is_too_long(None)


@pytest.mark.parametrize("service,status,body,figures", TOO_LONG_BODIES,
                         ids=[case[0] for case in TOO_LONG_BODIES])
def test_a_refusal_of_a_prompt_too_long_is_read_as_its_server_sends_it(
        service, status, body, figures):
    from app.providers.base import _refusal

    error = _refusal(status, json.dumps(body).encode())
    assert learning.is_too_long(error), service
    assert learning.too_long_figures(error.message, sent=1024, said=error.said) == figures


@pytest.mark.parametrize("service,status,body", NOT_TOO_LONG_BODIES,
                         ids=[case[0] for case in NOT_TOO_LONG_BODIES])
def test_a_refusal_of_something_else_is_no_prompt_too_long(service, status, body):
    from app.providers.base import _refusal

    assert not learning.is_too_long(_refusal(status, json.dumps(body).encode())), service


def test_the_room_of_the_reply_is_read_where_a_refusal_gives_it():
    # OpenRouter's, its prompt under the limit and a room that leaves no story its place.
    room = OPENROUTER_TOO_LONG.replace("130000 of text input, 10000", "2000 of text input, 138000")
    assert learning.reply_takes_the_room(room)
    assert learning.reply_takes_the_room(TOO_LONG_BODIES[0][2]["error"]["message"])
    # Anthropic's and DeepSeek's: under the limit, the reply's room leaves a story its place.
    for _, _, body, _ in TOO_LONG_BODIES[5:7]:
        assert not learning.reply_takes_the_room(body["error"]["message"]), body
    # Over the limit, whatever the room.
    assert not learning.reply_takes_the_room(OPENAI_TOO_LONG)
    assert not learning.reply_takes_the_room(NO_FIGURES, sent=10 ** 6)


def test_the_thinking_allowance_is_measured_once_there_is_one():
    assert ai_call.thinking_allowance({}) == ai_call.THINKING_ALLOWANCE
    assert ai_call.thinking_allowance({"reply_tokens_avg": "not json"}) == 3072
    # Twice the average once measured: half the replies think more than it.
    measured = json.dumps({"thinking": {"avg": 1495.6, "n": 1}})
    assert ai_call.thinking_allowance({"reply_tokens_avg": measured}) == 2991
    long = json.dumps({"thinking": {"avg": 2500, "n": 4}})
    assert ai_call.thinking_allowance({"reply_tokens_avg": long}) == 5000
    # Never under 1024, however little it thought.
    for little in (0, 300, 511.9):
        brief = json.dumps({"thinking": {"avg": little, "n": 3}})
        assert ai_call.thinking_allowance({"reply_tokens_avg": brief}) == 1024, little
    assert ai_call.thinking_allowance(
        {"reply_tokens_avg": json.dumps({"thinking": {"avg": 512.4, "n": 3}})}) == 1025
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
    assert usage == {"prompt": counting.seen[-1][0], "completion": 40, "model_id": ai["id"],
                     "model": ai["model"]}

    assert await send(client, convo["id"]) is None
    assert counting.calls[-1]["margin"] == max(200, int(16384 * 0.03))
    assert counting.calls[-1]["token_ratio"] == pytest.approx(by_hand)


async def test_another_model_forgets_what_the_one_before_measured(client, counting, monkeypatch):
    ai, convo = await a_story(client, read={"reasons": True}, reply_cap={"mode": "auto"})
    monkeypatch.setattr(counting, "times", 1.6)
    for _ in range(3):
        assert await send(client, convo["id"]) is None
    await set_row(ai["id"], fit_margin=0.1)
    row = await row_of(ai["id"])
    assert row["token_ratio_n"] == 3 and row["usage_seen"] == 1 and row["reply_tokens_avg"]

    resp = await client.put(f"/api/models/{ai['id']}", json={"model": "another"})
    assert resp.status_code == 200, resp.text
    row = await row_of(ai["id"])
    assert (row["token_ratio"], row["token_ratio_n"], row["fit_margin"], row["usage_seen"],
            row["reply_tokens_avg"]) == (None, 0, None, None, None)

    monkeypatch.setattr(counting, "times", 1.0)
    assert await send(client, convo["id"]) is None
    assert counting.calls[-1]["margin"] == int(16384 * 0.06)
    assert counting.calls[-1]["token_ratio"] is None
    assert (await row_of(ai["id"]))["token_ratio"] == pytest.approx(1.0, abs=0.01)


async def test_the_counts_of_the_model_before_are_not_the_new_ones(client, counting, monkeypatch):
    ai, convo = await a_story(client)
    await long_story(convo["id"], 4, 1300)
    monkeypatch.setattr(counting, "times", 1.6)
    for turn in range(2):
        if turn:
            await grown(convo["id"])
        assert await send(client, convo["id"]) is None
    resp = await client.put(f"/api/models/{ai['id']}", json={"model": "another"})
    assert resp.status_code == 200, resp.text

    # The new model counts what it is sent about as the engine estimates it, and its first count
    # lands just under 4096: far under the rate the model before showed, but no cut.
    await grown(convo["id"])
    counting.at = 4090
    assert await send(client, convo["id"]) is None
    (p1, e1), (p2, e2), (p3, e3) = counting.seen
    assert (p1, p2) == (round(1.6 * e1), round(1.6 * e2)) and e3 > e2 > e1 * 1.05
    assert 0.9 < p3 / e3 < 1.1 and p3 < 0.7 * 1.6 * e3
    meta = (await last_reply(client, convo))["meta"]
    assert "truncated" not in meta and meta["usage"]["model"] == "another"
    row = await row_of(ai["id"])
    assert (row["token_ratio"], row["token_ratio_n"]) == (pytest.approx(p3 / e3), 1)


async def without_model_names(convo_id: str) -> None:
    """The counts of the story as a reply stored them before they named their model."""
    conn = await open_db()
    try:
        rows = await (await conn.execute(
            "SELECT id, meta FROM messages WHERE conversation_id = ?", (convo_id,))).fetchall()
        for row in rows:
            meta = json.loads(row["meta"] or "{}")
            if isinstance(meta.get("usage"), dict) and meta["usage"].pop("model", None):
                await conn.execute("UPDATE messages SET meta = ? WHERE id = ?",
                                   (json.dumps(meta), row["id"]))
        await conn.commit()
    finally:
        await conn.close()


async def test_a_count_that_does_not_name_its_model_is_not_one_of_the_counts_before(
        client, reading):
    _, convo = await a_story(client)
    await long_story(convo["id"], 12, 1300)
    reading.counts = [3000, 3010, 3020]
    for turn in range(2):
        if turn:
            await grown(convo["id"])
        assert await send(client, convo["id"]) is None
    await without_model_names(convo["id"])

    # Named, the two counts before would make the third point of a plateau.
    await grown(convo["id"])
    assert await send(client, convo["id"]) is None
    assert reading.seen[-1][1] > reading.seen[0][1] * 1.05
    meta = (await last_reply(client, convo))["meta"]
    assert "truncated" not in meta and meta["usage"]["prompt"] == 3020


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
    assert reply["meta"]["truncated"] == {"read": 4090, "window": 16384, "version": 0,
                                          "model_id": ai["id"], "model": ai["model"]}
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
    assert meta["truncated"] == {"read": 3015, "window": 16384, "version": 0,
                                 "model_id": ai["id"], "model": ai["model"]}


def test_a_count_that_did_not_follow_the_story_stood_still():
    # Capped: the story grew 3 %, the count not at all, or less than half as much.
    assert learning.stood_still([(8192, 8436)], 8192, 8689)
    assert learning.stood_still([(8100, 8100)], 8192, 8500)
    assert learning.stood_still([(8192, 8436)], 8150, 8689)
    # Read whole: the count grew with the story, even at a lower rate than the story's.
    assert not learning.stood_still([(8436, 8436)], 8689, 8689)
    assert not learning.stood_still([(8000, 8000)], 8150, 8240)
    # A story that did not grow (a version rewritten, a window Evermind trims) or shrank.
    assert not learning.stood_still([(8192, 8436)], 8192, 8436)
    assert not learning.stood_still([(8192, 8436)], 8192, 8500)
    assert not learning.stood_still([(8192, 9000)], 6900, 6900)
    assert not learning.stood_still([], 8192, 8689)


class Capped:
    """A model's server that counts what it reads as ``times`` the engine's estimate, but reads
    no more than ``cap``: it drops the beginning of a longer story. Keeps (whole count, count,
    estimate)."""

    times = 1.1
    cap: ClassVar[int | None] = None
    seen: ClassVar[list] = []

    def __init__(self, call):
        self.figures = CallFigures()

    async def stream_chat(self, payload):
        self.figures.reset()
        estimate = payload.stats["used_tokens"]
        whole = round(Capped.times * estimate)
        prompt = whole if Capped.cap is None else min(whole, Capped.cap)
        Capped.seen.append((whole, prompt, estimate))
        self.figures.take_usage({"prompt_tokens": prompt, "completion_tokens": 40}, final=True)
        yield ProviderEvent(type="delta", text="*She nods.*")
        yield ProviderEvent(type="done", stop="stop")


@pytest.fixture()
def capped(monkeypatch):
    Capped.seen, Capped.cap = [], None
    monkeypatch.setattr("app.services.chat_service.get_provider", Capped)
    return Capped


async def grow_by(convo_id: str, share: float, estimate: int) -> None:
    """One message more, of about ``share`` of the story the engine last estimated."""
    await long_story(convo_id, 1, int(share * estimate * 3.5))


@pytest.mark.parametrize("cap", [8192, 6000])
@pytest.mark.parametrize("growth", [0.03, 0.06])
async def test_a_server_capped_under_a_growing_story_is_caught_before_it_teaches_a_ratio(
        client, capped, cap, growth):
    ai, convo = await a_story(client, context_own=16384)
    resp = await client.patch(f"/api/conversations/{convo['id']}", json={"play_style": "maximum"})
    assert resp.status_code == 200, resp.text
    # A story a little under the cap, at the rate the server counts.
    await long_story(convo["id"], int(cap * 0.85 / capped.times * 3.5 / 1300), 1300)
    capped.cap = cap
    over = flagged = 0
    for turn in range(16):
        if turn:
            await grow_by(convo["id"], growth, capped.seen[-1][2])
        assert await send(client, convo["id"]) is None
        whole = capped.seen[-1][0]
        meta = (await last_reply(client, convo))["meta"]
        over += whole > cap
        assert meta["context"]["budget"] <= 16384, (turn, meta["context"])
        if "truncated" in meta:
            assert meta["truncated"] == {"read": cap, "window": 16384, "version": 0,
                                         "model_id": ai["id"], "model": ai["model"]}
            flagged = over
            break
        # Until it is caught, the ratio stays near the rate the server counts at.
        row = await row_of(ai["id"])
        assert row["token_ratio"] == pytest.approx(capped.times, rel=0.03), (turn, row)
    assert 1 <= flagged <= 3, capped.seen

    # Once what it reads is observed, the story fits: nothing is cut, nothing flagged.
    resp = await client.post(f"/api/models/{ai['id']}/observed", json={"tokens": cap})
    assert resp.status_code == 200, resp.text
    for _ in range(5):
        await grow_by(convo["id"], growth, capped.seen[-1][2])
        assert await send(client, convo["id"]) is None
        whole, prompt, _ = capped.seen[-1]
        assert whole == prompt < cap
        meta = (await last_reply(client, convo))["meta"]
        assert "truncated" not in meta and meta["context"]["context_size"] == cap
    assert (await row_of(ai["id"]))["token_ratio"] == pytest.approx(capped.times, rel=0.03)


@pytest.mark.parametrize("growth", [0.03, 0.06])
async def test_a_server_that_reads_a_growing_story_whole_is_never_caught(client, capped, growth):
    ai, convo = await a_story(client, context_own=16384)
    resp = await client.patch(f"/api/conversations/{convo['id']}", json={"play_style": "maximum"})
    assert resp.status_code == 200, resp.text
    await long_story(convo["id"], 32, 1300)
    # It grows past what Evermind sends: from then on Evermind trims the story itself.
    for turn in range(14):
        if turn:
            await grow_by(convo["id"], growth, capped.seen[-1][2])
        assert await send(client, convo["id"]) is None
        assert "truncated" not in (await last_reply(client, convo))["meta"], turn
    assert capped.seen[-1][2] > 0.9 * (await last_reply(client, convo))["meta"]["context"]["budget"]
    # Every count was learned.
    row = await row_of(ai["id"])
    assert (row["token_ratio"], row["token_ratio_n"]) == (pytest.approx(capped.times, rel=1e-3), 14)

    # A version rewritten: the same story, the same count.
    for _ in range(3):
        assert await send(client, convo["id"], mode="regenerate") is None
        assert "truncated" not in (await last_reply(client, convo))["meta"]
    assert (await row_of(ai["id"]))["token_ratio_n"] == 17


async def test_a_ratio_stored_too_high_comes_down(client, counting, monkeypatch):
    ai, convo = await a_story(client)
    await long_story(convo["id"], 12, 1300)
    # Learned on a story in another script, or clamped by a refusal: the server counts what it is
    # sent as the engine estimates it, far under what the ratio stored says.
    await set_row(ai["id"], token_ratio=1.6, token_ratio_n=8)
    monkeypatch.setattr(counting, "times", 1.0)
    for turn in range(3):
        if turn:
            await grown(convo["id"])
        assert await send(client, convo["id"]) is None
        assert "truncated" not in (await last_reply(client, convo))["meta"]

    assert all(p < 0.7 * 1.6 * e for p, e in counting.seen)
    row = await row_of(ai["id"])
    assert row["token_ratio"] < 1.5 and row["token_ratio_n"] == 11


async def test_a_count_that_grew_with_the_story_is_not_a_truncation(
        client, counting, monkeypatch):
    ai, convo = await a_story(client)
    await long_story(convo["id"], 6, 1290)
    await set_row(ai["id"], token_ratio=1.4, token_ratio_n=8)
    monkeypatch.setattr(counting, "times", 0.85)
    for turn in range(3):
        if turn:
            await grown(convo["id"])
        assert await send(client, convo["id"]) is None
        assert "truncated" not in (await last_reply(client, convo))["meta"], turn

    # The third count lands just under 4096, far under the estimate at the ratio stored, but the
    # two before it grew with the story: the server reads what it is sent.
    (_, e1), (_, e2), (p3, e3) = counting.seen
    assert 4096 * 0.98 <= p3 <= 4096 and e3 > e2 > e1 * 1.05
    assert p3 < 0.7 * counting.calls[-1]["token_ratio"] * e3


async def test_a_server_counting_far_under_the_estimate_is_learned_once_its_counts_grew(
        client, counting, monkeypatch):
    ai, convo = await a_story(client)
    await long_story(convo["id"], 12, 1300)
    monkeypatch.setattr(counting, "times", 0.6)
    for turn in range(3):
        if turn:
            await grown(convo["id"])
        assert await send(client, convo["id"]) is None
        assert "truncated" not in (await last_reply(client, convo))["meta"], turn
        row = await row_of(ai["id"])
        # Far under the estimate at 1.0, a count teaches nothing until two before it grew with
        # the story and so prove that the server reads what it is sent.
        assert row["token_ratio_n"] == (1 if turn == 2 else 0), turn

    assert row["token_ratio"] == pytest.approx(0.6, abs=0.01)
    assert all(p < 0.7 * e for p, e in counting.seen)
    # None lands just under a round size, which would be a cut whatever was proved.
    assert not any(size * 0.98 <= p <= size for p, _ in counting.seen
                   for size in (2048, 4096, 8192))


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


async def test_a_truncation_names_its_version_until_another_is_written_whole(
        client, monkeypatch):
    ai, convo = await a_story(client)
    await long_story(convo["id"], 22, 1300)
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    model.answers = [answer("*She shrugs.*", usage={"prompt_tokens": 4090})]
    assert await send(client, convo["id"], mode="regenerate") is None
    reply = await last_reply(client, convo)
    read = {"read": 4090, "window": 16384, "version": 1, "model_id": ai["id"],
            "model": ai["model"]}
    assert reply["meta"]["truncated"] == read

    # Back to the version before: the line is the other version's, and says so.
    resp = await client.patch(f"/api/messages/{reply['id']}", json={"active_index": 0})
    assert resp.json()["meta"]["truncated"] == read
    # A version that broke off is not whole: the one read from its end still says it.
    model.answers = [[chunk(content="She"), json.dumps({"error": {"message": "boom"}})]]
    assert (await send(client, convo["id"], mode="regenerate"))["kind"] == "model_error"
    reply = await last_reply(client, convo)
    assert len(reply["variants"]) == 3 and reply["meta"]["truncated"] == read
    # One written whole, and read whole, is the end of it.
    model.answers = [answer("*She waits.*", usage={"prompt_tokens": 9000})]
    assert await send(client, convo["id"], mode="regenerate") is None
    assert "truncated" not in (await last_reply(client, convo))["meta"]


async def test_a_truncation_goes_when_its_version_is_rewritten_by_hand(client, monkeypatch):
    _, convo = await a_story(client)
    await long_story(convo["id"], 22, 1300)
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    model.answers = [answer("*She shrugs.*", usage={"prompt_tokens": 4090})]
    assert await send(client, convo["id"], mode="regenerate") is None
    reply = await last_reply(client, convo)

    edited = (await client.patch(f"/api/messages/{reply['id']}",
                                 json={"content": "She smiles.", "active_index": 0})).json()
    assert edited["meta"]["truncated"]["version"] == 1
    edited = (await client.patch(f"/api/messages/{reply['id']}",
                                 json={"content": "She shrugs, slowly.", "active_index": 1})).json()
    assert "truncated" not in edited["meta"]


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

    async def spied(db, call, model, *, message, estimate, **said):
        estimates.append(estimate)
        await learn(db, call, model, message=message, estimate=estimate, **said)

    monkeypatch.setattr(learning, "after_too_long", spied)
    model = Model((400, {"error": {"message": OPENAI_TOO_LONG}}), writing("*She nods.*")
                  ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None

    assert len(model.bodies) == 2
    assert [call["context_size"] for call in model.calls] == [16384, 8192]
    row = await row_of(ai["id"])
    assert (row["context_read"], row["context_read_kind"], row["context_own"]) == (
        8192, "observed", None)
    # The messages' part of what was requested, the reply's room left out.
    assert 0.5 < 8476 / estimates[0] < 2.0
    assert row["token_ratio"] == pytest.approx(8476 / estimates[0])
    assert row["token_ratio_n"] == 1
    assert (await last_reply(client, convo))["content"] == "*She nods.*"


async def test_a_refusal_naming_a_limit_under_the_size_typed_forgets_that_size(client, monkeypatch):
    # An AI from an update, its size typed larger than its server takes.
    ai, convo = await a_long_story(client, context_own=32768)
    refusal = (400, {"error": LMSTUDIO_TOO_LONG.replace("4096", "8000")})
    model = Model(refusal, writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None

    # Refused once, then answered, the story made shorter for what the server named.
    assert [call["context_size"] for call in model.calls] == [32768, 8000]
    assert len(json.dumps(model.bodies[1])) < len(json.dumps(model.bodies[0]))
    assert (await last_reply(client, convo))["content"] == "*She nods.*"
    row = await row_of(ai["id"])
    assert (row["context_own"], row["context_read"], row["context_read_kind"]) == (
        None, 8000, "observed")
    listed = next(one for one in (await client.get("/api/models")).json()
                  if one["id"] == ai["id"])["context"]
    assert (listed["own"], listed["read"], listed["read_kind"], listed["used"]) == (
        None, 8000, "observed", 8000)

    # The next turn is asked once.
    model.answers, model.bodies, model.calls = [writing("*She smiles.*")], [], []
    assert await send(client, convo["id"]) is None
    assert (len(model.bodies), model.calls[0]["context_size"]) == (1, 8000)


def test_a_refusal_naming_a_limit_over_the_size_typed_keeps_it():
    call = {"context_size": 6000, "max_tokens": 1024}
    current = {"context_own": 6000, "context_read": None, "fit_margin": None}
    taught = learning.lesson(call, current, message=LMSTUDIO_TOO_LONG.replace("4096", "8000"),
                             estimate=5000)
    assert "context_own" not in taught
    assert (taught["context_read"], taught["context_read_kind"]) == (8000, "observed")


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

    async def spied(db, call, model, *, message, estimate, **said):
        estimates.append(estimate)
        await learn(db, call, model, message=message, estimate=estimate, **said)

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
    other, story = await a_long_story(client, context_own=None, model="second")
    estimates.clear()
    model.answers, model.bodies = [(400, {"error": {"message": (
        "This model's maximum context length is 8192 tokens. However, you requested 900000 "
        "tokens (899000 in the messages, 1000 in the completion).")}}), writing("*She nods.*")], []
    assert await send(client, story["id"]) is None
    assert 899000 / estimates[0] > 10
    row = await row_of(other["id"])
    assert (row["token_ratio"], row["token_ratio_n"]) == (2.0, 1)


async def test_a_refusal_with_both_figures_replaces_the_margin_it_widened(client, monkeypatch):
    ai, convo = await a_long_story(client, context_own=None)
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
    ai, convo = await a_long_story(client)
    same = LMSTUDIO_TOO_LONG.replace("4096", "16384")
    model = Model((400, {"error": {"message": same}}), writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    assert model.calls[0]["context_size"] == 16384
    row = await row_of(ai["id"])
    assert (row["fit_margin"], row["context_read"], row["token_ratio"]) == (
        pytest.approx(0.10), None, None)


async def test_a_refusal_that_leaves_no_prompt_widens_the_margin(client, monkeypatch):
    ai, convo = await a_long_story(client, reply_cap={"mode": "auto"})
    # What was requested is no more than the room sent for the reply.
    bare = "This model's maximum context length is 16384 tokens. However, you requested 500 tokens."
    model = Model((400, {"error": {"message": bare}}), writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    assert model.bodies[0]["max_tokens"] >= 500
    row = await row_of(ai["id"])
    assert (row["fit_margin"], row["token_ratio"], row["token_ratio_n"], row["context_read"]) == (
        pytest.approx(0.10), None, 0, None)

    # A size apart from the one counted is all such a refusal teaches.
    other, story = await a_long_story(client, context_own=None, model="second",
                                      reply_cap={"mode": "auto"})
    model.answers, model.bodies = [(400, {"error": {"message": bare.replace("16384", "8192")}}),
                                   writing("*She nods.*")], []
    assert await send(client, story["id"]) is None
    row = await row_of(other["id"])
    assert (row["fit_margin"], row["token_ratio"], row["context_read"],
            row["context_read_kind"]) == (None, None, 8192, "observed")


async def test_a_refusal_on_a_story_opening_on_the_greeting_does_not_fold_it(client, monkeypatch):
    ai, convo = await a_story(client)
    model = Model((400, {"error": {"message": NO_FIGURES}}), writing("*She nods.*")
                  ).serve(monkeypatch)
    outcome = await send(client, convo["id"])
    # The story fits whatever the margin: it is not asked again, folded or not.
    (first,) = (body["messages"] for body in model.bodies)
    assert first[1]["role"] == "assistant" and "She stirs" in first[1]["content"]
    assert (outcome["kind"], outcome["message"]) == ("model_error", NO_FIGURES)
    assert (await row_of(ai["id"]))["fit_margin"] is None


async def test_a_too_long_refusal_without_figures_widens_the_margin(client, monkeypatch):
    ai, convo = await a_long_story(client)
    refusal = (400, {"error": {"message": NO_FIGURES}})
    model = Model().serve(monkeypatch)
    for widened in (0.10, 0.20, 0.30, 0.40):
        model.answers, model.bodies = [refusal, writing("*She nods.*")], []
        assert await send(client, convo["id"]) is None
        assert (await row_of(ai["id"]))["fit_margin"] == pytest.approx(widened)
    assert model.calls[-1]["margin"] == int(16384 * 0.06) + int(0.40 * 16384)

    # At the widest, no shorter prompt is made: the server's refusal is told as it is.
    model.answers, model.bodies = [refusal, writing("*She nods.*")], []
    outcome = await send(client, convo["id"])
    assert (outcome["kind"], len(model.bodies)) == ("model_error", 1)
    assert (await row_of(ai["id"]))["fit_margin"] == pytest.approx(0.40)

    model.answers, model.bodies = [answer("*She nods.*", usage={"prompt_tokens": 5000})], []
    assert await send(client, convo["id"]) is None
    row = await row_of(ai["id"])
    assert (row["fit_margin"], row["token_ratio_n"]) == (None, 1)


async def test_a_second_refusal_ends_the_turn_saying_so(client, monkeypatch):
    ai, convo = await a_long_story(client)
    await set_row(ai["id"], fit_margin=0.1)
    before = len(await messages_of(client, convo["id"]))
    model = Model((400, {"error": {"message": NO_FIGURES}})).serve(monkeypatch)
    outcome = await send(client, convo["id"])

    assert outcome["kind"] == "model_too_long"
    assert outcome["message"] == NO_FIGURES
    assert len(model.bodies) == 2
    assert len(json.dumps(model.bodies[1])) < len(json.dumps(model.bodies[0]))
    messages = await messages_of(client, convo["id"])
    assert len(messages) == before + 1 and messages[-1]["role"] == "user"
    assert messages[-1]["meta"]["unanswered"]["kind"] == "model_too_long"
    # The wider margin cured nothing: what the turn added is taken back.
    assert (await row_of(ai["id"]))["fit_margin"] == pytest.approx(0.1)


async def test_a_second_refusal_keeps_the_figures_it_learned(client, monkeypatch):
    ai, convo = await a_long_story(client, context_own=None)
    await set_row(ai["id"], fit_margin=0.2)
    Model((400, {"error": {"message": OPENAI_TOO_LONG}})).serve(monkeypatch)
    assert (await send(client, convo["id"]))["kind"] == "model_too_long"
    row = await row_of(ai["id"])
    # What the server said of its size and its count is so, answered or not.
    assert (row["context_read"], row["token_ratio_n"], row["fit_margin"]) == (8192, 1, None)


async def test_a_refusal_of_a_story_that_already_fitted_is_not_asked_again(client, monkeypatch):
    ai, convo = await a_story(client)
    await long_story(convo["id"], 16, 1300)
    untouched = await row_of(ai["id"])
    # As OpenAI words a refusal with no figure: the story fits, a wider margin changes nothing
    # of it, and the same body would be refused again.
    said = ("Your input exceeds the context window of this model. Please adjust your input and "
            "try again.")
    model = Model((400, {"error": {"message": said}}), writing("*She nods.*")).serve(monkeypatch)
    outcome = await send(client, convo["id"])
    assert (outcome["kind"], outcome["message"], len(model.bodies)) == ("model_error", said, 1)
    assert await row_of(ai["id"]) == untouched


async def test_a_refusal_of_the_reply_s_room_is_not_a_story_too_long(client, monkeypatch):
    ai, convo = await a_long_story(client, context_own=None)
    untouched = await row_of(ai["id"])
    # The prompt alone is under the limit, and the room asked for the reply leaves none for any
    # story: no shorter story would be answered.
    said = ("This endpoint's maximum context length is 8192 tokens. However, you requested "
            "about 10000 tokens (2000 of text input, 8000 in the output). Please reduce the "
            "length of either one, or use the \"middle-out\" transform to compress your prompt "
            "automatically.")
    assert learning.reply_takes_the_room(said.replace("8192", "131072").replace(
        "10000", "140000").replace("8000 in", "138000 in"), sent=138000)
    model = Model((400, {"error": {"message": said}}), writing("*She nods.*")).serve(monkeypatch)
    outcome = await send(client, convo["id"])
    assert (outcome["kind"], outcome["message"], len(model.bodies)) == ("model_error", said, 1)
    assert await row_of(ai["id"]) == untouched


async def test_a_prompt_under_the_limit_whose_room_leaves_a_story_its_place_is_too_long(
        client, monkeypatch):
    ai, convo = await a_long_story(client, context_own=None)
    # DeepSeek's form: the prompt alone is under the limit, but longer than the room the reply
    # leaves it. A shorter story is the cure.
    said = ("This model's maximum context length is 16384 tokens. However, you requested 16824 "
            "tokens (15800 in the messages, 1024 in the completion). Please reduce the length of "
            "the messages or completion.")
    model = Model((400, {"error": {"message": said}}), writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    assert len(model.bodies) == 2
    assert (await row_of(ai["id"]))["token_ratio_n"] == 1


async def test_the_figures_of_a_refusal_s_body_are_learned(client, monkeypatch):
    ai, convo = await a_long_story(client, context_own=None)
    estimates = spy_on_refusals(monkeypatch)
    # llama.cpp before its words gave figures: its body still did.
    body = {"error": {"code": 400, "type": "exceed_context_size_error",
                      "message": "the request exceeds the available context size, try increasing it",
                      "n_prompt_tokens": 9000, "n_ctx": 8192}}
    model = Model((400, body), writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    assert [call["context_size"] for call in model.calls] == [16384, 8192]
    row = await row_of(ai["id"])
    assert (row["context_read"], row["context_read_kind"]) == (8192, "observed")
    assert (row["token_ratio"], row["token_ratio_n"]) == (pytest.approx(9000 / estimates[0]), 1)


async def test_a_refusal_known_by_its_code_alone_widens_the_margin(client, monkeypatch):
    ai, convo = await a_long_story(client)
    # Groq's: no figure, and no word of a context.
    body = {"error": {"message": "Please reduce the length of the messages or completion.",
                      "code": "context_length_exceeded"}}
    model = Model((400, body), writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    assert len(model.bodies) == 2
    assert (await row_of(ai["id"]))["fit_margin"] == pytest.approx(0.10)


@pytest.mark.parametrize("service,status,body", NOT_TOO_LONG_BODIES,
                         ids=[case[0] for case in NOT_TOO_LONG_BODIES])
async def test_a_refusal_of_something_else_is_told_and_teaches_nothing(
        client, monkeypatch, service, status, body):
    ai, convo = await a_long_story(client)
    untouched = await row_of(ai["id"])
    model = Model((status, body), writing("*She nods.*")).serve(monkeypatch)
    outcome = await send(client, convo["id"])
    assert outcome["kind"] != "model_too_long" and len(model.bodies) == 1, service
    assert await row_of(ai["id"]) == untouched


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
    assert context["reply_room"] == 1024 + 2 * thinking


async def test_a_reply_cut_at_its_ceiling_teaches_no_length(client, monkeypatch):
    ai, convo = await a_story(client)
    Model([chunk(content="She opens"), finish("length"), counted(5000, 1024), "[DONE]"]
          ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    row = await row_of(ai["id"])
    assert row["token_ratio_n"] == 1
    assert "medium" not in json.loads(row["reply_tokens_avg"] or "{}")


async def test_thinking_shorter_than_the_reply_is_counted_as_none(client, monkeypatch):
    ai, convo = await a_story(client, read={"reasons": True}, reply_cap={"mode": "auto"})
    Model(answer("*She nods.* " * 40, usage={"prompt_tokens": 5000, "completion_tokens": 3})
          ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    averages = json.loads((await row_of(ai["id"]))["reply_tokens_avg"])
    assert averages["thinking"] == {"avg": 0, "n": 1}


async def test_a_continuation_teaches_no_reply_length(client, monkeypatch):
    ai, convo = await a_story(client)
    model = Model(answer("*She nods.*", usage={"prompt_tokens": 5000, "completion_tokens": 300})
                  ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    model.answers = [answer(" And smiles.", usage={"prompt_tokens": 5100,
                                                    "completion_tokens": 900})]
    assert await send(client, convo["id"], mode="continue") is None
    row = await row_of(ai["id"])
    assert json.loads(row["reply_tokens_avg"])["medium"] == {"avg": 300, "n": 1}
    assert row["token_ratio_n"] == 2


async def test_an_ai_that_names_another_model_by_the_end_of_the_reply_learns_nothing(
        client, reading):
    ai, convo = await a_story(client)
    reading.counts = [5000]

    async def renamed(call):
        await set_row(call["model_id"], model="another")

    reading.during = renamed
    assert await send(client, convo["id"]) is None
    row = await row_of(ai["id"])
    assert (row["model"], row["usage_seen"], row["token_ratio"], row["reply_tokens_avg"]) == (
        "another", None, None, None)


async def test_the_ratio_measured_is_what_the_estimate_is_read_against(client, monkeypatch):
    ai, convo = await a_story(client)
    await long_story(convo["id"], 22, 1300)
    # A server that counts much less than the engine estimates, and has said so before.
    await set_row(ai["id"], token_ratio=0.55, token_ratio_n=8)
    Model(answer("*She nods.*", usage={"prompt_tokens": 4090})).serve(monkeypatch)
    assert await send(client, convo["id"]) is None

    meta = (await last_reply(client, convo))["meta"]
    estimate = meta["context"]["used_tokens"]
    assert 4090 < 0.7 * estimate and not 4090 < 0.7 * round(estimate * 0.55)
    assert "truncated" not in meta
    assert (await row_of(ai["id"]))["token_ratio_n"] == 9


async def test_what_was_observed_dates_the_ai(client):
    ai = await add_model(client, base_url=HOSTED)
    await set_row(ai["id"], updated_at="2026-11-01T10:00:00+00:00")
    resp = await client.post(f"/api/models/{ai['id']}/observed", json={"tokens": 4096})
    assert resp.json()["updated_at"] > "2026-11-01T10:00:00+00:00"
    assert (await row_of(ai["id"]))["updated_at"] == resp.json()["updated_at"]


@pytest.fixture()
def lists(monkeypatch) -> Lists:
    served = Lists()
    monkeypatch.setattr("app.providers.catalog.client_factory", served.factory)
    return served


async def test_a_size_taught_by_a_refusal_holds_against_a_read_made_by_itself(
        client, monkeypatch, lists):
    ai, convo = await a_long_story(client, context_own=None)
    # The list says more than the server takes.
    lists.routes["/v1/models"] = {"data": [{"id": "mock", "context_length": 32768}]}
    Model((400, {"error": {"message": OPENAI_TOO_LONG}}), writing("*She nods.*")
          ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    await limits.drain()
    taught = (await model_of(client, ai["id"]))["context"]
    assert taught["read"] == 8192

    limits.schedule_refresh(ai["id"], fresh=False)
    await limits.drain()
    after = (await model_of(client, ai["id"]))["context"]
    assert (after["read"], after["read_kind"]) == (8192, taught["read_kind"])

    # Read again on the AI's page, at the person's asking: what the server says is taken.
    resp = await client.post(f"/api/models/{ai['id']}/refresh", json={"fresh": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["model"]["context"]["read"] == 32768
