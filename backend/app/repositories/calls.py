"""The rows of `calls` once written (services/calls.py writes them), and every sum the page shows of
them. The sums are made in SQL: a year of play is tens of thousands of rows, and no row is read
into Python to add it up.

The names shown are those of today while the thing exists (a conversation renamed shows its new
title); the name copied at call time only stands for a thing deleted."""

import csv
import io
from collections.abc import AsyncIterator
from decimal import Decimal
from typing import TYPE_CHECKING, Literal

import aiosqlite

from ..db import _connect, write_transaction
# The module, not its names: services/calls.py is still being read when this one is imported
# through it.
from ..services import calls as recorder
from . import settings as settings_repo
from .base import loads

if TYPE_CHECKING:
    from ..services.calls import Pricing
    from ..services.periods import Period


async def claim(db: aiosqlite.Connection, job_ids: list[str], card_id: str, name: str,
                kind: str) -> int:
    """The drafts of a card not saved yet, now that it is: what writing her cost counts under her
    name. A row that already names a card keeps it. Commits. Returns how many rows it took."""
    if not job_ids:
        return 0
    cursor = await db.execute(
        "UPDATE calls SET card_id = ?, card_name = ?, card_kind = ?"
        f" WHERE card_id IS NULL AND job_id IN ({', '.join('?' for _ in job_ids)})",
        (card_id, name, kind, *job_ids))
    await db.commit()
    return cursor.rowcount


async def reprice(db: aiosqlite.Connection, model_id: str, model: str, pricing: "Pricing") -> int:
    """Inside the caller's transaction: the rows of that AI and that server id with no price get
    the price typed now. Returns how many.

    A known amount never changes, a refusal costs nothing, and a call still running ends with the
    price copied at its start. A typed price has no cache prices: what came from the cache, or
    went to it, is counted as money_of counts it then."""
    cursor = await db.execute(
        "UPDATE calls SET"
        " price_in = :pin, price_out = :pout, price_cache_read = NULL, price_cache_write = NULL,"
        " price_source = 'typed_later', local = 0, cost_source = 'computed',"
        " cost = (MAX(0, tokens_in - COALESCE(tokens_cached, 0) - COALESCE(tokens_cache_write, 0))"
        " * :pin"
        " + COALESCE(tokens_cached, 0) * :pin"
        " + COALESCE(tokens_cache_write, 0) * 2 * :pin"
        " + tokens_out * :pout) / 1e6"
        " WHERE model_id = :model_id AND model_asked = :model"
        " AND cost_source = 'none' AND outcome NOT IN ('refused', 'running')",
        {"pin": pricing.price_in, "pout": pricing.price_out, "model_id": model_id,
         "model": model})
    return cursor.rowcount


# The fragments every sum shares.
# What was spent, what the original service billed through a key of one's own included.
MONEY = "(COALESCE(c.cost, 0) + COALESCE(c.cost_upstream, 0))"
# At home, or a price that came to exactly nothing: never an amount.
FREE = f"(c.local = 1 OR (c.cost_source <> 'none' AND {MONEY} = 0))"
# Read something, and no price for it. A refusal read nothing.
UNPRICED = "(c.cost_source = 'none' AND c.outcome <> 'refused' AND c.local = 0)"
# A call under way is not counted until it ends.
IN_PERIOD = "(c.started_at >= :lo AND c.started_at < :hi AND c.outcome <> 'running')"
REPLIES = "c.purpose IN ('reply', 'regenerate', 'continue')"
# What a row adds to a sum: a free row adds nothing, even one a server at home said a cost for.
SPENT = f"(CASE WHEN {FREE} THEN 0 ELSE {MONEY} END)"
# The filter of one AI, on the lists that follow it.
OF_MODEL = "(:model IS NULL OR c.model_id = :model)"
# The seven uses the page names: a memory pass and a condensation are both memory.
USE = "(CASE c.purpose WHEN 'consolidation' THEN 'memory' ELSE c.purpose END)"
USES = ("reply", "regenerate", "continue", "pen", "memory", "card", "speed")
# A long list is cut to its dearest; the rest is one line.
LISTED = 50
# The characters of an AI opened: the line opened stays under 2 KB with a year of play.
LISTED_IN_DETAIL = 12


def _money(value) -> float:
    return round(value or 0.0, 6)


async def _one(db: aiosqlite.Connection, sql: str, args: dict | tuple = ()) -> aiosqlite.Row:
    return await (await db.execute(sql, args)).fetchone()


async def _all(db: aiosqlite.Connection, sql: str, args: dict | tuple = ()) -> list:
    return list(await (await db.execute(sql, args)).fetchall())


async def since(db: aiosqlite.Connection) -> str:
    """Since when calls are counted: the update, or the last clear, or an older row still kept."""
    row = await _one(db, "SELECT (SELECT value FROM settings WHERE key = 'spending_since'),"
                         " (SELECT MIN(started_at) FROM calls)")
    noted, oldest = loads(row[0], None), row[1]
    return min(v for v in (noted, oldest, recorder.instant()) if isinstance(v, str))


async def _uses(db, where: str, args: dict, *, unpriced_tokens: bool = True,
                free: bool = True) -> list[list]:
    rows = await _all(db, f"""
        SELECT {USE} AS u, SUM({SPENT}) AS cost, COUNT(*) AS n, SUM(c.attempt >= 1),
               SUM({UNPRICED}), SUM(CASE WHEN {UNPRICED} THEN c.tokens_in ELSE 0 END),
               SUM(CASE WHEN {UNPRICED} THEN c.tokens_out ELSE 0 END), SUM({FREE})
        FROM calls c WHERE {IN_PERIOD} AND {where}
        GROUP BY u ORDER BY cost DESC, n DESC, u""", args)
    out = []
    for r in rows:
        line = [r[0], _money(r[1]), r[2], r[3], r[4]]
        if unpriced_tokens:
            line += [r[5], r[6]]
        if free:
            line.append(r[7])
        out.append(line)
    return out


def _split(rows: list, width: int, cut: int = LISTED) -> tuple[list[list], list | None]:
    """The rows of a ranked list (slot first, then ``width`` columns, then the lines the slot
    holds): the ``cut`` dearest, and the rest in one line [lines, cost, calls, unpriced_calls]."""
    listed, rest = [], None
    for r in rows:
        if r[0] <= cut:
            listed.append(list(r[1:width + 1]))
        else:
            rest = [r[width + 1], _money(r["cost"]), r["n"], r["unpriced"]]
    for line in listed:
        line[3] = _money(line[3])
    return listed, rest


# Ranked by what was spent, then by how often, then the latest first: the same order each time.
_RANKED = ("r AS (SELECT g.*, ROW_NUMBER() OVER (ORDER BY cost DESC, n DESC, last DESC, id)"
           " AS k FROM g)")


async def _cards(db, args: dict, where: str = OF_MODEL,
                 cut: int = LISTED) -> tuple[list[list], list | None]:
    # A draft of a card not saved yet has no card: all of them are one line, "New card".
    rows = await _all(db, f"""
        WITH g AS (
            SELECT c.card_id AS id,
                   CASE WHEN c.card_id IS NULL THEN NULL ELSE COALESCE(ch.name, c.card_name) END
                       AS name,
                   COALESCE(ch.kind, c.card_kind) AS kind, SUM({SPENT}) AS cost, COUNT(*) AS n,
                   SUM({UNPRICED}) AS unpriced, SUM(NOT {FREE}) = 0 AS free_only,
                   c.card_id IS NOT NULL AND ch.id IS NULL AS deleted, MAX(c.started_at) AS last
            FROM calls c LEFT JOIN characters ch ON ch.id = c.card_id
            WHERE {IN_PERIOD} AND {where}
              AND (c.card_id IS NOT NULL OR (c.purpose = 'card' AND c.job_id IS NOT NULL))
            GROUP BY c.card_id),
        {_RANKED}
        SELECT MIN(k) AS slot, id, name, kind, SUM(cost) AS cost, SUM(n) AS n,
               SUM(unpriced) AS unpriced, free_only, deleted, COUNT(*)
        FROM r GROUP BY CASE WHEN k <= {cut} THEN k ELSE {cut + 1} END ORDER BY slot""",
                          args)
    listed, rest = _split(rows, 8, cut)
    for line in listed:
        line[6], line[7] = bool(line[6]), bool(line[7])
    return listed, rest


async def _conversations(db, args: dict) -> tuple[list[list], list | None]:
    rows = await _all(db, f"""
        WITH g AS (
            SELECT c.conversation_id AS id, COALESCE(v.title, c.conversation_title) AS title,
                   COALESCE(vc.name, c.card_name) AS card_name, SUM({SPENT}) AS cost,
                   COUNT(*) AS n, SUM({UNPRICED}) AS unpriced, SUM(NOT {FREE}) = 0 AS free_only,
                   v.id IS NULL AS deleted, MAX(c.started_at) AS last
            FROM calls c LEFT JOIN conversations v ON v.id = c.conversation_id
                 LEFT JOIN characters vc ON vc.id = v.character_id
            WHERE {IN_PERIOD} AND {OF_MODEL} AND c.conversation_id IS NOT NULL
            GROUP BY c.conversation_id),
        {_RANKED}
        SELECT MIN(k) AS slot, id, title, card_name, SUM(cost) AS cost, SUM(n) AS n,
               SUM(unpriced) AS unpriced, free_only, deleted, COUNT(*)
        FROM r GROUP BY CASE WHEN k <= {LISTED} THEN k ELSE {LISTED + 1} END ORDER BY slot""",
                          args)
    listed, rest = _split(rows, 8)
    for line in listed:
        line[6], line[7] = bool(line[6]), bool(line[7])
    return listed, rest


async def _series(db, p: "Period") -> list[list]:
    """One bar a bucket: the replies, and the rest. The buckets are a table of bounds joined to
    the rows, so that each is an index range."""
    bounds = ", ".join("(?, ?, ?)" for _ in p.buckets)
    args = [value for i, (_, lo, hi) in enumerate(p.buckets) for value in (i, lo, hi)]
    rows = await _all(db, f"""
        WITH b(i, lo, hi) AS (VALUES {bounds})
        SELECT b.i, COALESCE(SUM(CASE WHEN {REPLIES} THEN {SPENT} END), 0),
               COALESCE(SUM(CASE WHEN NOT ({REPLIES}) THEN {SPENT} END), 0)
        FROM b LEFT JOIN calls c
             ON c.started_at >= b.lo AND c.started_at < b.hi AND c.outcome <> 'running'
        GROUP BY b.i ORDER BY b.i""", tuple(args))
    return [[p.buckets[r[0]][0], _money(r[1]), _money(r[2])] for r in rows]


async def summary(db: aiosqlite.Connection, p: "Period", model_id: str | None) -> dict:
    """GET /api/spending. The filter of one AI narrows the uses, the characters and the
    conversations, and gives its own total; the total, the period before, the bars, the AIs and
    the free ones always count everything."""
    args = {"lo": p.lo, "hi": p.hi, "model": model_id}
    head = await _one(db, f"""
        SELECT SUM({SPENT}), COUNT(*), SUM(CASE WHEN c.model_id = :model THEN {SPENT} END),
               SUM(CASE WHEN c.cost_source = 'reported' THEN {SPENT} END),
               SUM(CASE WHEN c.cost_source = 'computed' AND c.price_source = 'read'
                        THEN {SPENT} END),
               SUM(CASE WHEN c.cost_source = 'computed'
                         AND c.price_source IN ('typed', 'typed_later') THEN {SPENT} END),
               SUM(CASE WHEN c.cost_source = 'computed' AND c.tokens_source <> 'server'
                        THEN {SPENT} END),
               SUM(CASE WHEN NOT ({REPLIES}) THEN {SPENT} END), SUM(NOT ({REPLIES})),
               SUM({UNPRICED}), SUM(CASE WHEN {UNPRICED} THEN c.tokens_in ELSE 0 END),
               SUM(CASE WHEN {UNPRICED} THEN c.tokens_out ELSE 0 END)
        FROM calls c WHERE {IN_PERIOD}""", args)
    previous = None
    if p.previous is not None:
        before = await _one(db, f"SELECT SUM({SPENT}) FROM calls c WHERE {IN_PERIOD}",
                            {"lo": p.previous[0], "hi": p.previous[1]})
        previous = _money(before[0])
    models = await _all(db, f"""
        SELECT c.model_id, COALESCE(m.name, c.model_name), COALESCE(s.name, c.service_name),
               SUM(COALESCE(c.cost, 0)) AS cost, SUM(COALESCE(c.cost_upstream, 0)) AS upstream_cost,
               c.upstream, COUNT(*), SUM({REPLIES}), SUM(c.tokens_in), SUM(c.tokens_out),
               SUM({UNPRICED}), m.id IS NULL, MAX(c.started_at) AS last
        FROM calls c LEFT JOIN models m ON m.id = c.model_id
             LEFT JOIN connections s ON s.id = m.connection_id
        WHERE {IN_PERIOD} AND NOT {FREE}
        GROUP BY c.model_id ORDER BY cost + upstream_cost DESC, last DESC""", args)
    free = await _all(db, f"""
        SELECT c.model_id, COALESCE(m.name, c.model_name),
               CASE WHEN c.loopback = 1 THEN 'pc' WHEN c.local = 1 THEN 'network'
                    ELSE 'service' END,
               SUM({REPLIES}), SUM(c.tokens_in) AS tokens, MAX(c.started_at) AS last,
               COALESCE(s.name, c.service_name)
        FROM calls c LEFT JOIN models m ON m.id = c.model_id
             LEFT JOIN connections s ON s.id = m.connection_id
        WHERE {IN_PERIOD} AND {FREE}
        GROUP BY c.model_id ORDER BY tokens DESC, last DESC""", args)
    cards, cards_rest = await _cards(db, args)
    conversations, conversations_rest = await _conversations(db, args)
    return {
        "since": await since(db), "currency": "USD",
        "total": _money(head[0]),
        "model_total": _money(head[2]) if model_id is not None else None,
        "previous": previous, "calls": head[1],
        "sources": {"reported": _money(head[3]), "computed_read": _money(head[4]),
                    "computed_typed": _money(head[5]), "estimated": _money(head[6])},
        "outside_replies": {"cost": _money(head[7]), "calls": head[8] or 0},
        "uses": await _uses(db, OF_MODEL, args),
        "series": {"step": p.step, "points": await _series(db, p)},
        "models": [[r[0], r[1], r[2], _money(r[3]), _money(r[4]), r[5], r[6], r[7], r[8], r[9],
                    r[10], bool(r[11])] for r in models],
        "free": [[r[0], r[1], r[2], r[3], r[4], r[6]] for r in free],
        "cards": cards, "cards_rest": cards_rest,
        "conversations": conversations, "conversations_rest": conversations_rest,
        "unpriced": {"calls": head[9] or 0, "tokens_in": head[10] or 0,
                     "tokens_out": head[11] or 0},
    }


async def _models_of(db, where: str, args: dict) -> list[list]:
    """[model_id, name, cost, calls, unpriced_calls, free] of the rows ``where`` names."""
    rows = await _all(db, f"""
        SELECT c.model_id, COALESCE(m.name, c.model_name), SUM({SPENT}) AS cost, COUNT(*),
               SUM({UNPRICED}), SUM(NOT {FREE}) = 0, MAX(c.started_at) AS last
        FROM calls c LEFT JOIN models m ON m.id = c.model_id
        WHERE {IN_PERIOD} AND {where}
        GROUP BY c.model_id ORDER BY cost DESC, last DESC""", args)
    return [[r[0], r[1], _money(r[2]), r[3], r[4], bool(r[5])] for r in rows]


async def _detail_of_model(db, key: str, args: dict) -> dict | None:
    where = "c.model_id = :key"
    head = await _one(db, f"""
        SELECT COUNT(*), SUM(CASE WHEN {FREE} THEN 0 ELSE COALESCE(c.cost, 0) END),
               SUM(CASE WHEN {FREE} THEN 0 ELSE COALESCE(c.cost_upstream, 0) END),
               SUM({UNPRICED}), SUM(c.tokens_in), SUM(c.tokens_out),
               SUM(COALESCE(c.tokens_cached, 0)), SUM(COALESCE(c.tokens_reasoning, 0)),
               SUM(CASE WHEN c.cost_source = 'reported' THEN {SPENT} END),
               SUM(CASE WHEN c.cost_source = 'computed' AND c.price_source = 'read'
                        THEN {SPENT} END),
               SUM(CASE WHEN c.cost_source = 'computed'
                         AND c.price_source IN ('typed', 'typed_later') THEN {SPENT} END),
               SUM(CASE WHEN c.cost_source = 'computed' AND c.tokens_source <> 'server'
                        THEN {SPENT} END),
               MAX(c.cost_source = 'computed' AND COALESCE(c.tokens_cached, 0) > 0
                   AND c.price_cache_read IS NULL)
        FROM calls c WHERE {IN_PERIOD} AND {where}""", args)
    if not head[0]:
        return None
    names = await _one(db, f"""
        SELECT COALESCE(m.name, c.model_name), COALESCE(s.name, c.service_name), m.id IS NULL,
               c.upstream, MAX(c.started_at)
        FROM calls c LEFT JOIN models m ON m.id = c.model_id
             LEFT JOIN connections s ON s.id = m.connection_id
        WHERE {IN_PERIOD} AND {where}""", args)
    model = await _one(db, "SELECT * FROM models WHERE id = ?", (args["key"],))
    # The characters it served, cut as the page's own list is: an AI that served hundreds would
    # make the line opened tens of KB.
    cards, cards_rest = await _cards(db, args, where, LISTED_IN_DETAIL)
    return {
        "name": names[0], "service_name": names[1], "deleted": bool(names[2]),
        "priceable": model is not None and recorder.pricing_of(dict(model)).source is None,
        "per100": (await per100_all(db, args["key"])).get(args["key"]),
        "cost": _money(head[1]), "cost_upstream": _money(head[2]),
        "upstream": names[3], "calls": head[0], "unpriced_calls": head[3],
        "tokens": {"in": head[4], "out": head[5], "cached": head[6], "reasoning": head[7]},
        "sources": {"reported": _money(head[8]), "computed_read": _money(head[9]),
                    "computed_typed": _money(head[10]), "estimated": _money(head[11])},
        "at_most": bool(head[12]),
        "uses": await _uses(db, where, args, unpriced_tokens=False, free=False),
        "cards": [[line[0], line[1], line[2], line[3], line[4], line[7]] for line in cards],
        "cards_rest": cards_rest,
    }


async def _detail_of_card(db, key: str, args: dict) -> dict | None:
    # The empty key is the line of the drafts of cards not saved yet.
    where = ("c.card_id = :key" if key else
             "(c.card_id IS NULL AND c.purpose = 'card' AND c.job_id IS NOT NULL)")
    head = await _one(db, f"""
        SELECT COUNT(*), SUM({SPENT}), SUM({UNPRICED}), c.card_name, c.card_kind,
               MAX(c.started_at)
        FROM calls c WHERE {IN_PERIOD} AND {where}""", args)
    if not head[0]:
        return None
    card = await _one(db, "SELECT name, kind FROM characters WHERE id = ?", (key,)) \
        if key else None
    conversations = await _all(db, f"""
        SELECT c.conversation_id, COALESCE(v.title, c.conversation_title), SUM({SPENT}) AS cost,
               COUNT(*), SUM({UNPRICED}), v.id IS NULL, MAX(c.started_at) AS last
        FROM calls c LEFT JOIN conversations v ON v.id = c.conversation_id
        WHERE {IN_PERIOD} AND {where} AND c.conversation_id IS NOT NULL
        GROUP BY c.conversation_id ORDER BY cost DESC, last DESC""", args)
    return {
        "name": (card["name"] if card else head[3]) if key else None,
        "kind": card["kind"] if card else head[4],
        "deleted": bool(key) and card is None,
        "cost": _money(head[1]), "calls": head[0], "unpriced_calls": head[2],
        "models": await _models_of(db, where, args),
        "conversations": [[r[0], r[1], _money(r[2]), r[3], r[4], bool(r[5])]
                          for r in conversations],
    }


async def _detail_of_conversation(db, key: str, args: dict) -> dict | None:
    where = "c.conversation_id = :key"
    head = await _one(db, f"""
        SELECT COUNT(*), SUM({SPENT}), SUM({UNPRICED}), c.conversation_title, c.card_name,
               MAX(c.started_at)
        FROM calls c WHERE {IN_PERIOD} AND {where}""", args)
    if not head[0]:
        return None
    convo = await _one(db, "SELECT v.title, ch.name FROM conversations v"
                           " LEFT JOIN characters ch ON ch.id = v.character_id WHERE v.id = ?",
                       (key,))
    # How the price of a reply grew as the story did: the first tenth against the last.
    growth = await _one(db, f"""
        WITH t AS (SELECT {MONEY} AS money, NTILE(10) OVER (ORDER BY c.started_at) AS tenth
                   FROM calls c
                   WHERE {IN_PERIOD} AND {where} AND {REPLIES} AND c.outcome = 'whole'
                     AND c.cost_source <> 'none' AND NOT {FREE})
        SELECT COUNT(*), AVG(CASE WHEN tenth = 1 THEN money END),
               AVG(CASE WHEN tenth = 10 THEN money END) FROM t""", args)
    return {
        "title": convo["title"] if convo else head[3],
        "card_name": convo["name"] if convo else head[4],
        "deleted": convo is None,
        "cost": _money(head[1]), "calls": head[0], "unpriced_calls": head[2],
        "models": await _models_of(db, where, args),
        "uses": await _uses(db, where, args, unpriced_tokens=False, free=False),
        "growth": {"first": _money(growth[1]), "last": _money(growth[2])}
        if growth[0] >= 10 else None,
    }


async def _detail_of_use(db, key: str, args: dict) -> dict | None:
    if key not in USES:
        return None
    where = f"{USE} = :key"
    [line] = await _uses(db, where, args, free=False) or [None]
    if line is None:
        return None
    return {
        "use": key, "cost": line[1], "calls": line[2], "retried": line[3],
        "unpriced_calls": line[4], "unpriced_tokens_in": line[5],
        "unpriced_tokens_out": line[6], "models": await _models_of(db, where, args),
    }


_DETAILS = {"model": _detail_of_model, "card": _detail_of_card,
            "conversation": _detail_of_conversation, "use": _detail_of_use}


async def detail(db: aiosqlite.Connection,
                 cut: Literal["model", "card", "conversation", "use"], key: str,
                 p: "Period") -> dict | None:
    """One line of the page, opened; None when it has no call in the period."""
    return await _DETAILS[cut](db, key, {"lo": p.lo, "hi": p.hi, "key": key})


async def total(db: aiosqlite.Connection, *, model: str | None, card: str | None,
                conversation: str | None, lo: str | None) -> dict:
    """What one AI, one character or one conversation cost since ``lo`` (None: ever), for the
    line on its own page. ``free``: it was called, and never for money."""
    column, key = next((c, k) for c, k in (("model_id", model), ("card_id", card),
                                            ("conversation_id", conversation)) if k is not None)
    row = await _one(db, f"""
        SELECT SUM({SPENT}), COUNT(*), SUM({UNPRICED}), SUM(NOT {FREE})
        FROM calls c
        WHERE c.{column} = :key AND c.outcome <> 'running' AND (:lo IS NULL OR c.started_at >= :lo)
        """, {"key": key, "lo": lo})
    return {"total": _money(row[0]), "currency": "USD", "calls": row[1],
            "unpriced_calls": row[2] or 0, "free": row[1] > 0 and not row[3]}


# Kept out of the file: the server's usage object is for a later reading, not for a sheet.
_NOT_EXPORTED = ("usage_raw",)
# A cell a spreadsheet would run as a formula.
_FORMULA = ("=", "+", "-", "@", "\t")
_BATCH = 500


def _cell(value):
    if isinstance(value, str) and value.startswith(_FORMULA):
        return "'" + value
    if isinstance(value, float):
        # The shortest digits that read back as the same number, with a decimal point: csv would
        # write a few tokens of a cheap model as 3e-05, which a sheet may not read as an amount.
        return format(Decimal(repr(value)), "f")
    return value


def _csv_line(values) -> str:
    out = io.StringIO()
    csv.writer(out, lineterminator="\r\n").writerow(values)
    return out.getvalue()


async def export_rows(lo: str | None, hi: str | None) -> AsyncIterator[str]:
    """Every ended call from ``lo`` to ``hi`` as CSV lines, the header first: every column but
    usage_raw, in the migration's order. On a connection of its own, by batches, since the
    response is sent after the request's own connection is closed."""
    conn = await _connect()
    try:
        columns = [r["name"] for r in await (await conn.execute(
            "PRAGMA table_info(calls)")).fetchall() if r["name"] not in _NOT_EXPORTED]
        yield _csv_line(columns)
        cursor = await conn.execute(
            f"SELECT {', '.join(columns)} FROM calls"
            " WHERE outcome <> 'running' AND (:lo IS NULL OR started_at >= :lo)"
            " AND (:hi IS NULL OR started_at < :hi) ORDER BY started_at, id",
            {"lo": lo, "hi": hi})
        while batch := await cursor.fetchmany(_BATCH):
            yield "".join(_csv_line([_cell(v) for v in r]) for r in batch)
    finally:
        await conn.close()


async def clear(db: aiosqlite.Connection, before: str | None, *, dry_run: bool) -> dict:
    """Removes the calls that ended before ``before`` (an instant; None: all), and counts from
    now. A call under way is left. ``dry_run``: what would go, and nothing written."""
    where = "outcome <> 'running' AND (:cut IS NULL OR started_at < :cut)"
    if dry_run:
        row = await _one(db, f"SELECT COUNT(*), MIN(started_at), MAX(started_at) FROM calls"
                             f" WHERE {where}", {"cut": before})
        return {"calls": row[0], "first": row[1], "last": row[2]}
    async with write_transaction(db):
        cursor = await db.execute(f"DELETE FROM calls WHERE {where}", {"cut": before})
        deleted = cursor.rowcount
        await settings_repo.store(db, "spending_since", recorder.instant())
    return {"deleted": deleted, "since": await since(db)}


async def forget(db: aiosqlite.Connection, cut: Literal["conversation", "card"], key: str) -> int:
    """Inside the caller's transaction: the money stays, the name copied goes. A character's
    goes with the titles of her conversations. Returns how many rows changed."""
    if cut == "conversation":
        cursor = await db.execute(
            "UPDATE calls SET conversation_title = NULL WHERE conversation_id = ?", (key,))
    else:
        cursor = await db.execute(
            "UPDATE calls SET card_name = NULL, conversation_title = NULL WHERE card_id = ?"
            " OR conversation_id IN (SELECT id FROM conversations WHERE character_id = ?)",
            (key, key))
    return cursor.rowcount


# What a hundred replies cost, measured: from 20 replies whose price is known.
MEASURED_FROM = 20
MEASURED_OVER = 100


async def per100_all(db: aiosqlite.Connection, only: str | None = None) -> dict[str, dict]:
    """model_id -> {cost, n, typed}: what its last 100 whole replies cost, made a hundred, for the
    AIs with 20 or more (``only``: that AI alone). Only the server id the AI names now counts: an
    id edited in place is another model.

    Each AI takes its own last 100 through the index on (model_id, started_at): the list of the
    AIs asks it on every page, and a year of play must not be read and sorted for it."""
    rows = await _all(db, f"""
        SELECT m.id AS model_id, COUNT(*) AS n, SUM({MONEY}) AS money,
               MAX(c.cost_source = 'computed' AND c.price_source IN ('typed', 'typed_later'))
                   AS typed
        FROM models m JOIN calls c ON c.rowid IN (
            SELECT x.rowid FROM calls x
            WHERE x.model_id = m.id AND x.model_asked = m.model
              AND x.purpose IN ('reply', 'regenerate', 'continue') AND x.outcome = 'whole'
              AND x.cost_source <> 'none'
            ORDER BY x.started_at DESC LIMIT {MEASURED_OVER})
        WHERE :only IS NULL OR m.id = :only
        GROUP BY m.id HAVING n >= {MEASURED_FROM}""", {"only": only})
    return {r["model_id"]: {"cost": _money(r["money"] * 100 / r["n"]), "n": r["n"],
                            "typed": bool(r["typed"])} for r in rows}
