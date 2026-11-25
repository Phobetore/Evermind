"""What a whole reply teaches Evermind of its AI, from what the server counted.

The engine estimates tokens without a tokenizer; the server knows. Its count against the estimate
(the ratio) lets the next prompt fill the window without spilling over, and narrows the margin kept
under it. A count far under the estimate, at a round size or standing still while the story grows,
is a server that read the story only from its end: that is said, and teaches no ratio. A refusal
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
# The statuses a server refuses a prompt too long with.
_TOO_LONG_STATUSES = (400, 413, 422)
# A refusal that names the context, or a count of tokens.
_TOO_LONG = re.compile(r"\bcontext\b|\bprompt is too long\b|\d[\d,]*\s+tokens\b", re.IGNORECASE)
_NUMBER = r"(\d[\d,]*)"
_LIMIT_THEN_ASKED = re.compile(
    rf"maximum context length is {_NUMBER} tokens.*?requested {_NUMBER} tokens",
    re.IGNORECASE | re.DOTALL)
_ASKED_OVER_LIMIT = re.compile(rf"{_NUMBER} tokens\s*>\s*{_NUMBER}", re.IGNORECASE)
_CONTEXT_SIZE = re.compile(rf"context size \({_NUMBER} tokens\)", re.IGNORECASE)


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


def truncated(*, prompt: int, estimate: int, ratio: float, model: dict,
              earlier: list[tuple[int, int]]) -> bool:
    """prompt < 0.7 × round(estimate × ratio), and either it sits within 2 % under a power of two
    from 2048 to 2^21, or under the model's context_read when its kind is configured or max; or
    the two earlier (prompt, estimate) of this conversation and this one are within 1 % of each
    other in prompt while this estimate is above the oldest one's by more than 5 %."""
    if not _far_under(prompt, estimate, ratio):
        return False
    if any(_just_under(prompt, size) for size in _ROUND_SIZES):
        return True
    read = model.get("context_read")
    if read and model.get("context_read_kind") in _SIZE_SET and _just_under(prompt, read):
        return True
    if len(earlier) < 2:
        return False
    # A count that stands still while the story grows is a server that drops its beginning.
    points = [*earlier[-2:], (prompt, estimate)]
    prompts = [p for p, _ in points]
    return (max(prompts) - min(prompts) <= PLATEAU * max(prompts)
            and estimate > points[0][1] * _GROWN)


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


def too_long_figures(message: str) -> tuple[int | None, int | None]:
    """(limit, requested) read from a refusal: "maximum context length is 8192 tokens. However,
    you requested 9500 tokens", "prompt is too long: 205000 tokens > 200000 maximum", "exceeds
    the available context size (4096 tokens)" (limit only)."""
    if found := _LIMIT_THEN_ASKED.search(message):
        return _figure(found.group(1)), _figure(found.group(2))
    if found := _ASKED_OVER_LIMIT.search(message):
        return _figure(found.group(2)), _figure(found.group(1))
    if found := _CONTEXT_SIZE.search(message):
        return _figure(found.group(1)), None
    return None, None


def is_too_long(error: object) -> bool:
    """A server that refused the request for a prompt longer than it reads."""
    return (isinstance(error, ProviderError) and error.status in _TOO_LONG_STATUSES
            and bool(_TOO_LONG.search(error.message or "")))


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
        # reply only if no ratio learned from the first two has hidden it.
        elif estimate > 0 and not _far_under(prompt, estimate, ratio):
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


async def after_too_long(db: aiosqlite.Connection, call: dict, model: dict, *, message: str,
                         estimate: int) -> None:
    """A refusal for a prompt too long: the size it names, when it differs from the one counted,
    and its count against the estimate when it gives both; else a wider margin, a share of the
    window more each time, up to FIT_MARGIN_MOST. What the person typed is never written."""
    limit, requested = too_long_figures(message)

    def change(current: dict) -> dict:
        sets: dict = {}
        if limit is not None and limit != call["context_size"]:
            sets.update(context_read=limit, context_read_kind="served")
        if limit is not None and requested is not None and estimate > 0:
            sets.update(token_ratio=_bounded(requested / estimate), token_ratio_n=1,
                        fit_margin=None)
        if not sets:
            sets["fit_margin"] = min(FIT_MARGIN_MOST,
                                     (current.get("fit_margin") or 0) + FIT_MARGIN_STEP)
        return sets

    if await models_repo.measure(db, call["model_id"], call["model"], change):
        logger.info("%s refused a prompt too long (%s): asked again", call["model_name"],
                    "its figures learned" if limit is not None else "a wider margin kept")
