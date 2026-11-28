"""What each request to a model's server leaves behind: one row of `calls`, and the rules that
read its counts, its price and its cost.

A row is inserted when the request starts ('running', with the prompt as the engine estimates
it) and completed when it ends, however it ends: whole, stopped by the person or by the server's
stop, failed, refused. Each write is on a short connection of its own and committed at once, so
that a caller's rollback, or a stop in the middle, never takes the row with it. Recording never
breaks a call: a write that fails is logged and the call goes on.

A recording is never opened inside a caller's write_transaction: BEGIN IMMEDIATE holds the
database, and the recorder's write would wait db.BUSY_TIMEOUT_S, then fail.

After its end, one thing alone completes a row here: OpenRouter's record of its generation, for a
call that ended there with no cost said (stopped, or never counted), read once the generation is
done on OpenRouter's side. A price typed later is the other (repositories/calls.py, reprice).
"""

import asyncio
import json
import logging
import math
from collections.abc import Callable, Coroutine
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import httpx

from ..db import _connect
from ..providers.base import LIST_DELAYS, CallFigures, Provider, ProviderError
from ..providers.catalog import LOCAL_FAMILIES, family_of, is_local, is_loopback
from ..repositories.base import new_id
from .learning import counts_of

logger = logging.getLogger(__name__)

Purpose = Literal["reply", "regenerate", "continue", "pen", "memory", "consolidation", "card",
                  "speed"]
Outcome = Literal["running", "whole", "stopped", "failed", "refused", "empty", "discarded"]


@dataclass(frozen=True)
class Who:
    """What a call served, copied onto its row."""

    purpose: Purpose
    conversation_id: str | None = None
    conversation_title: str | None = None
    card_id: str | None = None
    card_name: str | None = None
    card_kind: str | None = None
    job_id: str | None = None
    message_id: str | None = None
    variant: int | None = None


def for_conversation(purpose: Purpose, convo: dict, character: dict | None, *,
                     title: str | None = None, message_id: str | None = None,
                     variant: int | None = None) -> Who:
    """card_* from the character (id, name, kind); title given wins over convo["title"]."""
    return Who(
        purpose=purpose,
        conversation_id=convo.get("id"),
        conversation_title=title if title is not None else convo.get("title"),
        card_id=character.get("id") if character else None,
        card_name=character.get("name") if character else None,
        card_kind=character.get("kind") if character else None,
        message_id=message_id,
        variant=variant,
    )


def instant(moment: datetime | None = None) -> str:
    """UTC ISO with milliseconds and '+00:00', the one form every row and every bound takes:
    instants of that form sort as text as they sort in time."""
    moment = moment or datetime.now(UTC)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).isoformat(timespec="milliseconds")


@dataclass(frozen=True)
class Tokens:
    tokens_in: int
    tokens_out: int
    cached: int | None
    cache_write: int | None
    reasoning: int | None
    source: Literal["server", "estimated", "mixed"]


def estimated_out(chars: int) -> int:
    """Tokens for characters that arrived, as the engine estimates text (prompting/tokens.py)."""
    return 0 if chars <= 0 else int(chars / 3.5) + 1


def _count(value: object) -> int | None:
    """A count as a server gives one: a whole number, 0 or more. Anything else is not read."""
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def _inner(usage: dict, outer: str, key: str) -> int | None:
    nested = usage.get(outer)
    return _count(nested.get(key)) if isinstance(nested, dict) else None


def _first(*values: int | None) -> int | None:
    return next((value for value in values if value is not None), None)


def tokens_of(figures: CallFigures, *, outcome: Outcome, prompt_estimate: int) -> Tokens:
    """What the call read and wrote: the server's counts once its last one came; its prompt count
    and an estimate of what arrived when it stopped before that; else estimates alone. A refused
    call read nothing."""
    if outcome == "refused":
        return Tokens(0, 0, None, None, None, "server")
    usage = figures.usage if isinstance(figures.usage, dict) else {}
    arrived = estimated_out(figures.chars_out + figures.thought_chars)
    counts = counts_of(usage)
    if counts and figures.usage_final:
        tokens_in = counts[0]
        tokens_out = counts[1] if counts[1] is not None else arrived
        source: Literal["server", "estimated", "mixed"] = "server"
    elif counts:
        # Before its last count, a server's output count is a placeholder (Anthropic's 1).
        tokens_in, tokens_out, source = counts[0], arrived, "mixed"
    else:
        tokens_in, tokens_out, source = prompt_estimate, arrived, "estimated"
    return Tokens(
        tokens_in, tokens_out,
        cached=_first(_inner(usage, "prompt_tokens_details", "cached_tokens"),
                      _count(usage.get("cache_read_input_tokens"))),
        cache_write=_first(_inner(usage, "prompt_tokens_details", "cache_write_tokens"),
                           _count(usage.get("cache_creation_input_tokens"))),
        reasoning=_first(_inner(usage, "completion_tokens_details", "reasoning_tokens"),
                         _inner(usage, "output_tokens_details", "thinking_tokens")),
        source=source,
    )


@dataclass(frozen=True)
class Pricing:
    """USD per million tokens, as a call applies them."""

    price_in: float | None
    price_out: float | None
    cache_read: float | None
    cache_write: float | None
    source: Literal["read", "typed"] | None  # None: no whole price


_NO_PRICE = Pricing(None, None, None, None, None)


def pricing_of(model: dict) -> Pricing:
    """The price typed over the price read, as the page shows it. A price counts only whole: one
    half alone prices nothing. The cache's prices are only ever read, and only apply to a read
    price."""
    own_in, own_out = model.get("price_own_in"), model.get("price_own_out")
    price_in = own_in if own_in is not None else model.get("price_in")
    price_out = own_out if own_out is not None else model.get("price_out")
    if price_in is None or price_out is None:
        return _NO_PRICE
    if own_in is not None or own_out is not None:
        return Pricing(price_in, price_out, None, None, "typed")
    return Pricing(price_in, price_out, model.get("price_cache_read"),
                   model.get("price_cache_write"), "read")


def money_of(tokens: Tokens, pricing: Pricing) -> float:
    """What a whole price makes of the counts: what came from the cache at the cache's price,
    what was written to it at its own (twice the input's when none was read)."""
    price_in, price_out = pricing.price_in or 0.0, pricing.price_out or 0.0
    cached, written = tokens.cached or 0, tokens.cache_write or 0
    read_price = pricing.cache_read if pricing.cache_read is not None else price_in
    write_price = pricing.cache_write if pricing.cache_write is not None else 2 * price_in
    return (max(0, tokens.tokens_in - cached - written) * price_in + cached * read_price
            + written * write_price + tokens.tokens_out * price_out) / 1e6


def _money(value: object) -> float | None:
    if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value) \
            and value >= 0:
        return float(value)
    return None


def cost_of(figures: CallFigures, tokens: Tokens, pricing: Pricing, *, outcome: Outcome,
            local: bool) -> tuple[float | None, float | None, Literal["reported", "computed", "none"]]:
    """(cost, cost_upstream, cost_source): what the service said it charged; else, away from
    home, what its whole price makes; else nothing known. A refusal costs nothing."""
    if outcome == "refused":
        return 0.0, None, "none"
    usage = figures.usage if isinstance(figures.usage, dict) else {}
    reported = _money(usage.get("cost"))
    if reported is not None:
        details = usage.get("cost_details")
        upstream = _money(details.get("upstream_inference_cost")) \
            if isinstance(details, dict) else None
        return reported, upstream, "reported"
    if local:
        return None, None, "none"
    if pricing.source is not None:
        return money_of(tokens, pricing), None, "computed"
    return None, None, "none"


def _family(service: dict) -> str:
    return family_of(service.get("provider") or "", service.get("base_url") or "",
                     service.get("family") or "generic", service.get("family_url"))


def at_home(model: dict, service: dict) -> tuple[bool, bool]:
    """(local, loopback): a server of a family that loads its own models, at a private address,
    with no price read or typed, is never money; a gateway of no known family may forward to a
    paid service. loopback: on this PC rather than elsewhere on the network."""
    base_url = service.get("base_url") or ""
    family = _family(service)
    priced = any(model.get(key) is not None
                 for key in ("price_in", "price_out", "price_own_in", "price_own_out"))
    local = family in LOCAL_FAMILIES and is_local(family, base_url) and not priced
    return local, is_loopback(base_url)


def outcome_of(error: BaseException | None, figures: CallFigures, *, stopped: bool,
               wrote: bool) -> Outcome:
    """How a call ended. An error before the server had the request is a refusal, like an error
    status: neither reads nor writes anything."""
    if stopped or isinstance(error, asyncio.CancelledError):
        return "stopped"
    if isinstance(error, ProviderError) and error.status is not None:
        return "refused"
    if error is not None:
        return "refused" if not figures.sent else "failed"
    return "whole" if wrote else "empty"


# The writes that run beside a call: a generation id as soon as it comes, a call's end.
_tasks: set[asyncio.Task] = set()
# The generation-id writes among them, which a call's end writes again.
_id_writes: set[asyncio.Task] = set()
# The looks at OpenRouter's records among them, which the server's stop does not wait for.
_looks: set[asyncio.Task] = set()


def _spawn(work: Coroutine[Any, Any, None], *, id_write: bool = False,
           look: bool = False) -> asyncio.Task:
    task = asyncio.get_running_loop().create_task(work)
    _tasks.add(task)
    if id_write:
        _id_writes.add(task)
    if look:
        _looks.add(task)
    task.add_done_callback(_forget)
    return task


def _forget(task: asyncio.Task) -> None:
    _tasks.discard(task)
    _id_writes.discard(task)
    _looks.discard(task)
    if not task.cancelled():
        task.exception()


# How long a call's end waits for the database: past it the end is given up, said in the log,
# and the next start ends the row, as for a process killed. A stop must never hang on it.
END_WAITS_S = 5


async def _write(sql: str, params: tuple | dict, *, busy_timeout: float | None = None) -> int:
    """Returns how many rows it changed."""
    conn = await (_connect() if busy_timeout is None else _connect(busy_timeout))
    try:
        cursor = await conn.execute(sql, params)
        await conn.commit()
        return cursor.rowcount
    finally:
        await conn.close()


def _warn(what: str, exc: BaseException) -> None:
    # Its name alone: a traceback's values could hold a key. It should never happen.
    logger.warning("%s: %s", what, type(exc).__name__)


_COLUMNS = (
    "id", "started_at", "purpose", "attempt", "outcome", "conversation_id", "conversation_title",
    "card_id", "card_name", "card_kind", "job_id", "message_id", "variant", "model_id",
    "model_name", "service_id", "service_name", "family", "local", "loopback", "model_asked",
    "tokens_in", "price_in", "price_out", "price_cache_read", "price_cache_write",
    "price_source", "currency",
)
_INSERT = (f"INSERT INTO calls ({', '.join(_COLUMNS)})"
           f" VALUES ({', '.join(':' + c for c in _COLUMNS)})")
_ENDED = ("ended_at", "outcome", "status", "model_served", "upstream", "generation_id",
          "tokens_in", "tokens_out", "tokens_cached", "tokens_cache_write", "tokens_reasoning",
          "tokens_source", "cost", "cost_upstream", "cost_source", "usage_raw")
_END = (f"UPDATE calls SET {', '.join(f'{c} = :{c}' for c in _ENDED)} WHERE id = :id")


class Recording:
    """One call's row, from its start to its end (see `recording`)."""

    def __init__(self, provider: Provider, ai: tuple[dict, dict], who: Who, *, attempt: int,
                 prompt_estimate: int):
        self.row_id: str | None = None  # None when the insert failed: nothing more is written
        self._provider = provider
        self._model, self._service = ai
        self._who = who
        self._attempt = attempt
        ratio = self._model.get("token_ratio")
        if not self._model.get("token_ratio_n") or not ratio:
            ratio = 1
        # The engine's estimate as this AI's server has been seen to count.
        self._estimate = round(prompt_estimate * ratio)
        # A stand-in provider that only streams has no figures: its call is estimated.
        self._figures: CallFigures = getattr(provider, "figures", None) or CallFigures()
        self._marked: Outcome | None = None
        self._unsent = False
        self._error: BaseException | None = None
        self._row: dict = {}
        self._local = False

    def mark(self, outcome: Outcome, *, error: BaseException | None = None) -> None:
        """How the call ended, when its caller knows better than the stream: an answer thrown
        away is 'discarded'. ``error``: what ended it, when the caller caught it rather than let
        it through, for the status a refusal came with."""
        self._marked = outcome
        self._error = error

    def unsent(self) -> None:
        """The request never went to the model's server (stopped while its row was written): the
        row is removed on leaving, as a row stands for a request sent."""
        self._unsent = True

    async def __aenter__(self) -> "Recording":
        model, service, who = self._model, self._service, self._who
        pricing = pricing_of(model)
        self._local, loopback = at_home(model, service)
        row = {
            "id": new_id(), "started_at": instant(), "purpose": who.purpose,
            "attempt": self._attempt, "outcome": "running",
            "conversation_id": who.conversation_id, "conversation_title": who.conversation_title,
            "card_id": who.card_id, "card_name": who.card_name, "card_kind": who.card_kind,
            "job_id": who.job_id, "message_id": who.message_id, "variant": who.variant,
            "model_id": model.get("id"), "model_name": model.get("name"),
            "service_id": service.get("id"), "service_name": service.get("name"),
            "family": _family(service), "local": int(self._local), "loopback": int(loopback),
            "model_asked": getattr(self._provider, "model", None) or model.get("model"),
            "tokens_in": self._estimate,
            "price_in": pricing.price_in, "price_out": pricing.price_out,
            "price_cache_read": pricing.cache_read, "price_cache_write": pricing.cache_write,
            "price_source": pricing.source, "currency": "USD",
        }
        self._pricing = pricing
        try:
            await _write(_INSERT, row)
        except asyncio.CancelledError:
            # The server stopping, before the request went: a row stands for a request sent, and
            # one left running would be priced at its prompt by the next start. Removed whether
            # or not the insert was written, shielded as on leaving.
            self.row_id = row["id"]
            await asyncio.shield(_spawn(self._remove()))
            raise
        except Exception as exc:  # noqa: BLE001
            _warn("a call to a model could not be recorded", exc)
            return self
        self.row_id, self._row = row["id"], row
        self._figures.on_id = self._on_id
        return self

    def _on_id(self, figures: CallFigures) -> None:
        # Written at once, so that a process killed mid-reply leaves the id OpenRouter's record
        # is found by; never awaited by the reading.
        _spawn(self._write_id(figures.generation_id, figures.model_served), id_write=True)

    async def _write_id(self, generation_id: str | None, model_served: str | None) -> None:
        try:
            await _write("UPDATE calls SET generation_id = ?,"
                         " model_served = COALESCE(?, model_served) WHERE id = ?",
                         (generation_id, model_served, self.row_id))
        except Exception as exc:  # noqa: BLE001
            _warn("a generation id could not be recorded", exc)

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        if self.row_id is None:
            return False
        figures = self._figures
        if figures.on_id == self._on_id:
            figures.on_id = None
        if self._unsent:
            await asyncio.shield(_spawn(self._remove()))
            return False
        outcome = self._marked or outcome_of(
            exc, figures, stopped=isinstance(exc, asyncio.CancelledError),
            wrote=figures.chars_out > 0)
        tokens = tokens_of(figures, outcome=outcome, prompt_estimate=self._estimate)
        cost, upstream_cost, cost_source = cost_of(figures, tokens, self._pricing,
                                                   outcome=outcome, local=self._local)
        ended = {
            "ended_at": instant(), "outcome": outcome,
            "status": _status_of(exc or self._error),
            "model_served": figures.model_served, "upstream": figures.upstream,
            "generation_id": figures.generation_id,
            "tokens_in": tokens.tokens_in, "tokens_out": tokens.tokens_out,
            "tokens_cached": tokens.cached, "tokens_cache_write": tokens.cache_write,
            "tokens_reasoning": tokens.reasoning, "tokens_source": tokens.source,
            "cost": cost, "cost_upstream": upstream_cost, "cost_source": cost_source,
            "usage_raw": json.dumps(figures.usage) if figures.usage else None,
        }
        # Its own task, shielded: a second cancel, or the caller's own end, does not cut it.
        await asyncio.shield(_spawn(self._end({**self._row, **ended})))
        return False

    async def _remove(self) -> None:
        try:
            await _write("DELETE FROM calls WHERE id = ?", (self.row_id,))
        except Exception as exc:  # noqa: BLE001
            _warn("a call never sent could not be removed", exc)

    async def _end(self, row: dict) -> None:
        try:
            await _write(_END, {key: row[key] for key in (*_ENDED, "id")},
                         busy_timeout=END_WAITS_S)
        except Exception as exc:  # noqa: BLE001
            _warn("the end of a call to a model could not be recorded", exc)
            return
        try:
            _after_end(row)
        except Exception as exc:  # noqa: BLE001
            _warn("what follows a call's end could not be scheduled", exc)


def _status_of(error: BaseException | None) -> int | None:
    return error.status if isinstance(error, ProviderError) else None


def recording(provider: Provider, ai: tuple[dict, dict], who: Who, *, attempt: int = 0,
              prompt_estimate: int) -> AbstractAsyncContextManager[Recording]:
    """Around one request to ``provider``: its row inserted on entering, completed on leaving,
    the exception, if any, passed on untouched. ``ai`` is (model, service) as the repository
    gives them; ``prompt_estimate`` the engine's count of the prompt sent."""
    return Recording(provider, ai, who, attempt=attempt, prompt_estimate=prompt_estimate)


async def discard(row_id: str | None) -> None:
    """A call whose answer was thrown away after its end: its row says so."""
    if row_id is None:
        return
    try:
        await _write("UPDATE calls SET outcome = 'discarded' WHERE id = ?", (row_id,))
    except Exception as exc:  # noqa: BLE001
        _warn("a discarded call could not be marked", exc)


# OpenRouter's record of a generation.

RECONCILE_AFTER_S = (20, 120)      # after the call's end: first look, then the last one
RECONCILE_WITHIN_S = 3600          # past an hour after its start, a row is left as it is


def client_factory() -> httpx.AsyncClient:
    """The one door of the records' requests. The tests replace it."""
    return httpx.AsyncClient(timeout=LIST_DELAYS)


# A row OpenRouter's record may complete: a generation it names, no cost it said, an end that
# reached it, and recent enough for the record to be kept.
_DUE = ("generation_id IS NOT NULL AND cost_source <> 'reported' AND reconciled_at IS NULL"
        " AND outcome NOT IN ('running', 'refused') AND family = 'openrouter'"
        " AND started_at >= :since")


def _since() -> str:
    return instant(datetime.now(UTC) - timedelta(seconds=RECONCILE_WITHIN_S))


def _due(row: dict) -> bool:
    """_DUE, for a row as a call's end has it."""
    return (row.get("generation_id") is not None and row.get("cost_source") != "reported"
            and row.get("reconciled_at") is None
            and row.get("outcome") not in ("running", "refused")
            and row.get("family") == "openrouter" and (row.get("started_at") or "") >= _since())


async def _due_row(row_id: str) -> tuple[str, dict] | None:
    """(generation id, service with its key) of a row still due, the service as it is now."""
    conn = await _connect()
    try:
        row = await (await conn.execute(
            f"SELECT generation_id, service_id FROM calls WHERE id = :id AND {_DUE}",
            {"id": row_id, "since": _since()})).fetchone()
        if row is None:
            return None
        service = await (await conn.execute("SELECT * FROM connections WHERE id = ?",
                                            (row["service_id"],))).fetchone()
    finally:
        await conn.close()
    return (row["generation_id"], dict(service)) if service is not None else None


async def _record(generation_id: str, service: dict) -> dict | None:
    """The record's data, once OpenRouter has it; None for anything else. A 404 is what a record
    not written yet answers."""
    base = (service.get("base_url") or "").rstrip("/")
    async with client_factory() as client:
        response = await client.get(f"{base}/generation", params={"id": generation_id},
                                    headers={"Authorization": f"Bearer {service['api_key']}"},
                                    timeout=LIST_DELAYS)
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        logger.debug("a generation record answered %s", response.status_code)
        return None
    try:
        data = response.json().get("data")
    except (ValueError, AttributeError):
        logger.debug("a generation record could not be read")
        return None
    return data if isinstance(data, dict) else None


async def reconcile_row(row_id: str) -> bool:
    """One look at OpenRouter's record of the row's generation; True once written. The service is
    read again as it is now, for its key; gone, or no longer OpenRouter, nothing is asked."""
    try:
        due = await _due_row(row_id)
        if due is None:
            return False
        generation_id, service = due
        if _family(service) != "openrouter" or not service.get("api_key"):
            return False
        data = await _record(generation_id, service)
        if data is None or (cost := _money(data.get("total_cost"))) is None:
            return False
        counts = {key: _count(data.get(f"native_tokens_{name}")) for key, name in (
            ("tokens_in", "prompt"), ("tokens_out", "completion"),
            ("tokens_reasoning", "reasoning"), ("tokens_cached", "cached"))}
        changed = await _write(
            "UPDATE calls SET cost = :cost, cost_upstream = COALESCE(:upstream, cost_upstream),"
            " cost_source = 'reported',"
            " tokens_in = COALESCE(:tokens_in, tokens_in),"
            " tokens_out = COALESCE(:tokens_out, tokens_out),"
            " tokens_reasoning = COALESCE(:tokens_reasoning, tokens_reasoning),"
            " tokens_cached = COALESCE(:tokens_cached, tokens_cached),"
            # The record's counts are the server's own; a record without them leaves an estimate
            # said as one.
            " tokens_source = CASE WHEN :tokens_in IS NOT NULL AND :tokens_out IS NOT NULL"
            " THEN 'server' ELSE tokens_source END,"
            " reconciled_at = :now"
            " WHERE id = :id AND reconciled_at IS NULL AND cost_source <> 'reported'",
            {"id": row_id, "cost": cost, "upstream": _money(data.get("upstream_inference_cost")),
             "now": instant(), **counts})
    except Exception as exc:  # noqa: BLE001
        # A look that fails is looked at again, or left: never worth more than this.
        logger.debug("a generation record could not be looked at: %s", type(exc).__name__)
        return False
    if changed:
        logger.info("the cost of a call was read from OpenRouter's record")
    return bool(changed)


async def _look_after_end(row_id: str) -> None:
    first, last = RECONCILE_AFTER_S
    await asyncio.sleep(first)
    if await reconcile_row(row_id):
        return
    await asyncio.sleep(max(0, last - first))
    await reconcile_row(row_id)


def reconcile_soon(row: dict) -> None:
    """Looks at the row's record twice after its end: OpenRouter may not have written it yet."""
    _spawn(_look_after_end(row["id"]), look=True)


def _reconcile_if_due(row: dict) -> None:
    if _due(row):
        reconcile_soon(row)


# Called with each finished row, once written.
_after_end: Callable[[dict], None] = _reconcile_if_due


async def _look_at_every_due() -> None:
    try:
        conn = await _connect()
        try:
            due = await (await conn.execute(
                f"SELECT id FROM calls WHERE {_DUE} ORDER BY started_at",
                {"since": _since()})).fetchall()
        finally:
            await conn.close()
    except Exception as exc:  # noqa: BLE001
        logger.debug("the calls due a look could not be read: %s", type(exc).__name__)
        return
    for row in due:
        await reconcile_row(row["id"])


async def after_start() -> None:
    """Rows a process left 'running' (killed, or stopped before their end was written) ended
    then: stopped, with the prompt estimated at their start and nothing known of what came.
    Away from home, the whole price copied at their start prices that prompt, as cost_of would
    have; a price typed later must not. When they ended is not known: their start stands for it."""
    try:
        await _write("UPDATE calls SET outcome = 'stopped', tokens_out = 0,"
                     " tokens_source = 'estimated', ended_at = started_at,"
                     " cost = CASE WHEN price_source IS NOT NULL AND local = 0"
                     " THEN tokens_in * price_in / 1e6 END,"
                     " cost_source = CASE WHEN price_source IS NOT NULL AND local = 0"
                     " THEN 'computed' ELSE 'none' END"
                     " WHERE outcome = 'running'", ())
    except Exception as exc:  # noqa: BLE001
        _warn("calls left running could not be stopped", exc)
    # Those of them OpenRouter may complete, each looked at once, in the background: the start
    # does not wait on a service.
    _spawn(_look_at_every_due(), look=True)


async def stop() -> None:
    """At the server's stop. A call's end is one short write, awaited so that a reply stopped by
    the stop is kept as stopped; an id write is cancelled, since the end writes the id again; a
    look at a record is cancelled, since the next start looks again. An end written while the
    stop waits schedules its look then: each round cancels what came since."""
    while _tasks:
        for task in [*_id_writes, *_looks]:
            task.cancel()
        await asyncio.gather(*list(_tasks), return_exceptions=True)


async def drain() -> None:
    """Waits for every write under way, those a finished row schedules included."""
    while _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)
