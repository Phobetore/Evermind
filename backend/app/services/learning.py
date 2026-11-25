"""What a whole reply teaches Evermind of its AI, from what the server counted.

The engine estimates tokens without a tokenizer; the server knows. Its count against the estimate
(the ratio) lets the next prompt fill the window without spilling over, and narrows the margin kept
under it. A count standing still while the story grows, or far under the estimate at a round
size, is a server that read the story only from its end: that is said, and teaches no ratio; a
count that did not follow the story since the reply before teaches none either. A refusal
for a prompt too long teaches what it can, and the turn asks once more.

Only a whole reply teaches: a stopped one, a failed one or a memory pass never does.
"""

import json
import logging
import re

import aiosqlite

from ..prompting.tokens import estimate_tokens
from ..prompting.ways import REPLY_ROOM
from ..providers.base import CallFigures, ProviderError
from ..repositories import models as models_repo
from .ai_call import reply_averages

logger = logging.getLogger(__name__)

RATIO_BOUNDS = (0.5, 2.0)
RATIO_WINDOW = 8                   # replies of the moving average
TRUNCATED_BELOW = 0.7              # of the corrected estimate
ROUND_SIZE_SLACK = 0.02            # within 2 % under a plausible window
PLATEAU = 0.01                     # three counts within 1 % of each other
FIT_MARGIN_STEP, FIT_MARGIN_MOST = 0.10, 0.40

# The windows a server is plausibly set to: powers of two from 2048 to 2^21.
_ROUND_SIZES = tuple(2 ** k for k in range(11, 22))
# The kinds of a read size a server may load less than: what it is set to, or its maximum.
_SIZE_SET = ("configured", "max")
# A plateau is a story that grew meanwhile: by more than this over the oldest of the three.
_GROWN = 1.05
# A count followed the estimate when it grew by at least this share of the estimate's growth.
_FOLLOWED = 0.5
# The statuses a server refuses a prompt too long with.
_TOO_LONG_STATUSES = (400, 413, 422)
# What a server's error body names a prompt too long by, where it keeps it beside its words.
_TOO_LONG_CODE, _TOO_LONG_TYPE = "context_length_exceeded", "exceed_context_size_error"
# A refusal that names what the server reads at once, or a prompt too long or too large for it.
_TOO_LONG = re.compile(r"\bcontext (?:length|window|size|limit)\b|\bprompt is too long\b"
                       r"|\btoo large for model\b", re.IGNORECASE)
# Not a prompt too long, whatever else they say: a reply's ceiling above what the model writes
# or reads ("max_tokens is too large", "max_tokens: 10000 > 4096", "Invalid max_tokens value",
# "max_tokens=40000 cannot be greater than max_model_len"), or a rate of tokens a minute.
_CEILING_REFUSED = re.compile(
    r"\bmax_(?:completion_|new_)?tokens\W*(?:or\W+max_completion_tokens\W*)?"
    r"(?:is too large|cannot be greater|[:=]\s*\d[\d,]*\s*(?:>|cannot))|\binvalid max_tokens\b",
    re.IGNORECASE)
_RATE_LIMITED = re.compile(r"\brate limit|\bper minute\b|\(TPM\)", re.IGNORECASE)
_NUMBER = r"(\d[\d,]*)"
# The forms a refusal gives its figures in, each read as (limit, prompt); a None group is a
# figure it does not give. Read in this order: the first that matches is the refusal's.
_LIMIT = rf"maximum context length is {_NUMBER} tokens"
_FORMS: tuple[tuple[re.Pattern, int, int | None], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE | re.DOTALL), limit, prompt) for pattern, limit, prompt in (
        # OpenAI's and vLLM's 0.6: "you requested 40000 tokens in the messages".
        (rf"{_LIMIT}.*?requested {_NUMBER} tokens in the messages", 1, 2),
        # OpenAI's: "your messages resulted in 7403 tokens".
        (rf"{_LIMIT}.*?resulted in {_NUMBER} tokens", 1, 2),
        # vLLM's: "your prompt contains 40000 input tokens", "your request has 40000 input tokens".
        (rf"{_LIMIT}.*?(?:contains|has) {_NUMBER} input tokens", 1, 2),
        # Anthropic's: "prompt is too long: 203073 tokens > 200000 maximum", and "input length and
        # `max_tokens` exceed context limit: 198882 + 21333 > 200000".
        (rf"{_NUMBER} tokens\s*>\s*{_NUMBER}", 2, 1),
        (rf"context limit:\s*{_NUMBER}\s*\+\s*\d[\d,]*\s*>\s*{_NUMBER}", 2, 1),
        # llama.cpp's: "request (9000 tokens) exceeds the available context size (8192 tokens)",
        # and "input (9000 tokens) is larger than the max context size (8192 tokens)".
        ((rf"\({_NUMBER} tokens\) (?:exceeds|is larger than) the .{{0,20}}?context size "
          rf"\({_NUMBER} tokens\)"), 2, 1),
        # Mistral's: "Prompt contains 277504 tokens and 0 draft tokens, too large for model with
        # 131072 maximum context length".
        (rf"prompt contains {_NUMBER} tokens.*?too large for model with {_NUMBER} maximum", 2, 1),
        # Ollama's service: "The prompt is too long: 297754, model maximum context length: 262144".
        (rf"prompt is too long:\s*{_NUMBER}\s*,\s*model maximum context length:\s*{_NUMBER}", 2, 1),
        # vLLM's: "Input length (40000) exceeds model's maximum context length (32768)".
        (rf"input length \({_NUMBER}\) exceeds .{{0,20}}?maximum context length \({_NUMBER}\)",
         2, 1),
        # The size alone: "context size (8192 tokens)", "context limit (1048568 tokens)", and LM
        # Studio's "loaded with context length of only 4096 tokens".
        (rf"context (?:size|limit|length) \({_NUMBER} tokens\)", 1, None),
        (rf"context length of only {_NUMBER} tokens", 1, None),
    ))
# OpenAI's says what was requested, its reply's room counted in, and OpenRouter's "about" it.
_LIMIT_THEN_ASKED = re.compile(rf"{_LIMIT}.*?requested (?:[a-z]+ )?{_NUMBER} tokens",
                               re.IGNORECASE | re.DOTALL)
# A maximum context length whose prompt is counted in characters, or not at all.
_LIMIT_ALONE = re.compile(_LIMIT, re.IGNORECASE)
# The messages' part of it, when the refusal goes on to give it.
_PROMPT_PART = re.compile(rf"\(\s*{_NUMBER} (?:in the messages|of text input)", re.IGNORECASE)
# The reply's part of what was requested, when the refusal gives it: OpenAI's and OpenRouter's,
# and Anthropic's "198882 + 21333 > 200000".
_REPLY_PART = re.compile(rf"{_NUMBER} in the (?:completion|output)\b"
                         rf"|context limit:\s*\d[\d,]*\s*\+\s*{_NUMBER}\s*>", re.IGNORECASE)
# The least the engine gives the story, whatever the reply keeps (engine.build_chat_payload).
_LEAST_BUDGET = 512


def _whole(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def counts_of(usage: dict) -> tuple[int, int | None] | None:
    """(prompt, completion) as the server counted them: prompt_tokens, else input_tokens +
    cache_read_input_tokens + cache_creation_input_tokens; completion_tokens, else output_tokens.
    None when the prompt count is missing, not an int, or not above 0."""
    if not isinstance(usage, dict):
        return None
    if "prompt_tokens" in usage:
        prompt = _whole(usage["prompt_tokens"])
    else:
        # Anthropic counts what it read from its cache apart from the rest.
        prompt = _whole(usage.get("input_tokens"))
        if prompt is not None:
            prompt += sum(_whole(usage.get(key)) or 0 for key in (
                "cache_read_input_tokens", "cache_creation_input_tokens"))
    if prompt is None or prompt <= 0:
        return None
    completion = _whole(usage.get("completion_tokens"))
    if completion is None:
        completion = _whole(usage.get("output_tokens"))
    if completion is not None and completion < 0:
        completion = None
    return prompt, completion


def _just_under(prompt: int, size: int) -> bool:
    return size * (1 - ROUND_SIZE_SLACK) <= prompt <= size


def _far_under(prompt: int, estimate: int, ratio: float) -> bool:
    return prompt < TRUNCATED_BELOW * round(estimate * ratio)


def _rate_shown(earlier: list[tuple[int, int]]) -> float | None:
    """The rate the server counted this story at, when its last two counts moved with the
    estimate: the estimate changed by more than 5 %, the count by more than PLATEAU the same
    way, and neither count is far under the other's rate. That server reads what it is sent.
    None when there is no such proof."""
    if len(earlier) < 2:
        return None
    (p1, e1), (p2, e2) = earlier[-2:]
    if min(p1, p2, e1, e2) <= 0:
        return None
    moved = e2 > e1 * _GROWN or e1 > e2 * _GROWN
    followed = abs(p2 - p1) > PLATEAU * max(p1, p2) and (p2 > p1) == (e2 > e1)
    rates = (p1 / e1, p2 / e2)
    alike = min(rates) >= TRUNCATED_BELOW * max(rates)
    return _bounded(rates[1]) if moved and followed and alike else None


def _plateau(earlier: list[tuple[int, int]], prompt: int, estimate: int) -> bool:
    """The two earlier counts and this one within PLATEAU of each other while this estimate is
    above the oldest one's by more than 5 %: a server that drops the beginning of a story that
    grows. A server that reads what it is sent counts more as the story grows; a story that did
    not grow (a version rewritten, a window Evermind trims itself) shows none."""
    if len(earlier) < 2:
        return False
    points = [*earlier[-2:], (prompt, estimate)]
    prompts = [p for p, _ in points]
    return (max(prompts) - min(prompts) <= PLATEAU * max(prompts)
            and estimate > points[0][1] * _GROWN)


def stood_still(earlier: list[tuple[int, int]], prompt: int, estimate: int) -> bool:
    """The count did not follow the estimate since the last counted reply: the estimate grew by
    more than PLATEAU while the count grew by less than half as much (or fell). A server capped
    under the story counts the same whatever is added; one that reads what it is sent counts the
    added text too, at less than half the story's rate only for text far unlike the rest."""
    if not earlier:
        return False
    last_prompt, last_estimate = earlier[-1]
    if min(last_prompt, last_estimate) <= 0 or estimate <= last_estimate * (1 + PLATEAU):
        return False
    grown = estimate / last_estimate - 1
    return prompt / last_prompt - 1 < _FOLLOWED * grown


def truncated(*, prompt: int, estimate: int, ratio: float, model: dict,
              earlier: list[tuple[int, int]]) -> bool:
    """The two earlier (prompt, estimate) of this conversation and this one make a plateau
    (``_plateau``), however near the estimate the count is; or prompt < 0.7 × round(estimate ×
    ratio) and it sits within 2 % under a power of two from 2048 to 2^21, or under the model's
    context_read when its kind is configured or max. When the two earlier counts moved with the
    story, the rate they show stands for ``ratio``: a ratio stored before (another script, a
    refusal's guess) would make a count at that rate look cut."""
    # Judged on its own: a server capped a little under the story counts a little under it, and
    # each such count learned as a ratio would hide the next one.
    if _plateau(earlier, prompt, estimate):
        return True
    ratio = _rate_shown(earlier) or ratio
    if not _far_under(prompt, estimate, ratio):
        return False
    if any(_just_under(prompt, size) for size in _ROUND_SIZES):
        return True
    read = model.get("context_read")
    return bool(read and model.get("context_read_kind") in _SIZE_SET and _just_under(prompt, read))


def _bounded(ratio: float) -> float:
    return min(max(ratio, RATIO_BOUNDS[0]), RATIO_BOUNDS[1])


def _moved(average: float | None, n: int, sample: float) -> tuple[float, int]:
    """A moving average over the last RATIO_WINDOW samples, moved towards ``sample``."""
    if not n or average is None:
        return sample, 1
    return average + (sample - average) / min(n + 1, RATIO_WINDOW), n + 1


def next_ratio(model: dict, sample: float) -> tuple[float, int]:
    """The average over the last RATIO_WINDOW replies moved towards sample (clamped), and n."""
    return _moved(model.get("token_ratio"), model.get("token_ratio_n") or 0, _bounded(sample))


def _figure(text: str) -> int:
    return int(text.replace(",", ""))


def too_long_figures(message: str, *, sent: int | None = None,
                     said: dict | None = None) -> tuple[int | None, int | None]:
    """(limit, prompt) read from a refusal: from the error body's own figures when it keeps them
    (llama.cpp's n_ctx and n_prompt_tokens, in ``said``), else from its words, in each form a
    server words them (_FORMS). What OpenAI's form requested holds the reply's room: the prompt
    is the messages' part when it is given, else what is left once ``sent``, the max_tokens the
    request carried, is taken away. A maximum context length alone is the limit alone."""
    said = said or {}
    if isinstance(said.get("n_ctx"), int) and isinstance(said.get("n_prompt_tokens"), int):
        return said["n_ctx"], said["n_prompt_tokens"]
    for pattern, limit, prompt in _FORMS:
        if found := pattern.search(message):
            return (_figure(found.group(limit)),
                    None if prompt is None else _figure(found.group(prompt)))
    if found := _LIMIT_THEN_ASKED.search(message):
        if part := _PROMPT_PART.search(message, found.end()):
            return _figure(found.group(1)), _figure(part.group(1))
        return _figure(found.group(1)), _figure(found.group(2)) - (sent or 0)
    if found := _LIMIT_ALONE.search(message):
        return _figure(found.group(1)), None
    return None, None


def _reply_part(message: str) -> int | None:
    found = _REPLY_PART.search(message)
    return _figure(found.group(1) or found.group(2)) if found else None


def is_too_long(error: object) -> bool:
    """A server that refused the request for a prompt longer than it reads: its error body's
    code (context_length_exceeded) or type (exceed_context_size_error) says so, or its words
    do. Never a ceiling above what the model writes, nor a rate of tokens a minute."""
    if not isinstance(error, ProviderError) or error.status not in _TOO_LONG_STATUSES:
        return False
    message = error.message or ""
    said = getattr(error, "said", None) or {}
    if (_CEILING_REFUSED.search(message) or _RATE_LIMITED.search(message)
            or said.get("code") == "rate_limit_exceeded"):
        return False
    return (said.get("code") == _TOO_LONG_CODE or said.get("type") == _TOO_LONG_TYPE
            or bool(_TOO_LONG.search(message)))


async def after_whole_reply(db: aiosqlite.Connection, call: dict, model: dict, *,
                            figures: CallFigures, estimate: int, length: str | None,
                            visible: str, earlier: list[tuple[int, int]]) -> dict | None:
    """Writes what the reply teaches, in this order: truncation check; else the ratio; the reply
    length; the thinking; usage_seen. Returns meta.truncated {"read": prompt, "window":
    context_size} when truncated, else None. ``length`` is the way's reply length, None for a
    reply that has no length of its own (cut at its ceiling, or a continuation)."""
    counts = counts_of(figures.usage)
    cut = None

    def change(current: dict) -> dict:
        nonlocal cut
        if counts is None:
            return {"usage_seen": 0}
        prompt, completion = counts
        sets: dict = {}
        ratio = call.get("token_ratio") or 1.0
        if truncated(prompt=prompt, estimate=estimate, ratio=ratio, model=model, earlier=earlier):
            cut = {"read": prompt, "window": call["context_size"]}
        # A count far under the estimate teaches no ratio even unproved: it may be a story read
        # only from its end that no round size shows, and that the plateau shows by the third
        # reply only if no ratio learned from the first two has hidden it. Far under is judged
        # at the rate this story's counts showed, else at no more than 1.0: judged at a ratio
        # stored too high, every count would be held back and that ratio never come down. Nor
        # does a count that stood still while the story grew: learned, it would lower the ratio,
        # widen the budget and send more of a story the server does not read.
        elif (estimate > 0 and not stood_still(earlier, prompt, estimate)
              and not _far_under(prompt, estimate, _rate_shown(earlier) or min(ratio, 1.0))):
            ratio, n = next_ratio(current, prompt / estimate)
            # What was measured replaces what a refusal had to guess.
            sets.update(token_ratio=ratio, token_ratio_n=n, fit_margin=None)
        if completion is not None:
            averages = reply_averages(current)
            if length in REPLY_ROOM:
                averages[length] = _entry(averages.get(length), completion)
            if current.get("reasons") == 1:
                # Its count holds its thinking: what the visible reply does not take.
                averages["thinking"] = _entry(averages.get("thinking"),
                                              max(0, completion - estimate_tokens(visible)))
            sets["reply_tokens_avg"] = json.dumps(averages)
        sets["usage_seen"] = 1
        return sets

    if not await models_repo.measure(db, call["model_id"], call["model"], change):
        return None
    if cut is not None:
        logger.info("%s read %d tokens of a prompt estimated at %d: its server read the story "
                    "only from its end", call["model_name"], cut["read"], estimate)
    elif counts is not None:
        logger.info("%s counted %d tokens where %d were estimated", call["model_name"],
                    counts[0], estimate)
    return cut


def _entry(entry: object, sample: float) -> dict:
    if isinstance(entry, dict) and isinstance(entry.get("avg"), int | float):
        average, n = _moved(float(entry["avg"]), _whole(entry.get("n")) or 0, sample)
    else:
        average, n = float(sample), 1
    return {"avg": average, "n": n}


def reply_takes_the_room(message: str, *, sent: int | None = None,
                         said: dict | None = None) -> bool:
    """A refusal whose figures say the prompt alone is under the limit, and the reply's room
    leaves less than the engine's least budget (512) for any story: "you requested about
    140000 tokens (2000 of text input, 138000 in the output)" from a server reading 131072. No
    shorter story would be answered: it is not a story too long. One whose room leaves a story
    its place (DeepSeek's "99645 in the messages, 8192 in the completion" of 102400) is: the
    prompt is longer than the server counts it is given."""
    limit, prompt = too_long_figures(message, sent=sent, said=said)
    room = _reply_part(message)
    if room is None:
        room = sent
    return (limit is not None and prompt is not None and room is not None and prompt < limit
            and limit - room < _LEAST_BUDGET)


def lesson(call: dict, current: dict, *, message: str, estimate: int,
           said: dict | None = None) -> dict:
    """What a refusal for a prompt too long teaches, against the AI as it is stored now: the size
    it names, when it differs from the one counted, and its count against the estimate when it
    gives both; else a wider margin, a share of the window more each time, up to
    FIT_MARGIN_MOST."""
    limit, prompt = too_long_figures(message, sent=call.get("max_tokens"), said=said)
    sets: dict = {}
    if limit is not None and limit != call["context_size"]:
        # What the server showed it takes, as a reply cut at its size shows it: a read of its
        # list made by itself, which may say more, does not undo it (models.store_read).
        sets.update(context_read=limit, context_read_kind="observed")
    if limit is not None and prompt is not None and prompt > 0 and estimate > 0:
        # A count of the whole prompt, as a reply's is: it moves the average, not replaces it.
        ratio, n = next_ratio(current, prompt / estimate)
        sets.update(token_ratio=ratio, token_ratio_n=n, fit_margin=None)
    if not sets:
        sets["fit_margin"] = min(FIT_MARGIN_MOST,
                                 (current.get("fit_margin") or 0) + FIT_MARGIN_STEP)
    return sets


async def after_too_long(db: aiosqlite.Connection, call: dict, model: dict, *, message: str,
                         estimate: int, said: dict | None = None) -> None:
    """Writes the ``lesson`` of a refusal for a prompt too long, once the prompt it makes is
    known to be shorter. What the person typed is never written."""

    def change(current: dict) -> dict:
        return lesson(call, current, message=message, estimate=estimate, said=said)

    if await models_repo.measure(db, call["model_id"], call["model"], change):
        logger.info("%s refused a prompt too long (%s): asked again", call["model_name"],
                    "its figures learned" if too_long_figures(message, said=said)[0] is not None
                    else "a wider margin kept")


async def take_back_margin(db: aiosqlite.Connection, call: dict, before: float | None) -> None:
    """The shorter prompt was refused too: the margin that turn added cured nothing."""
    await models_repo.measure(db, call["model_id"], call["model"],
                              lambda current: {"fit_margin": before})
