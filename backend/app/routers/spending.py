"""Spending: what the calls to the models cost, as sums. Periods are asked in the device's own
days (``tz``, its zone, and ``tzo``, its offset in minutes east of UTC, for a zone Python does
not know); no list of the calls one by one is ever served, save the CSV file."""

import re
from datetime import date, timedelta, tzinfo
from typing import Literal

import aiosqlite
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from ..db import get_db
from ..errors import BAD_PERIOD, AppError, NotFoundError
from ..models.schemas import ForgetIn
from ..repositories import calls as repo
from ..services import periods

router = APIRouter(prefix="/api/spending", tags=["spending"])

_ZONE = re.compile(r"[A-Za-z0-9_+\-/]{1,64}")
_OFFSET_MAX = 840  # minutes: the farthest zones are 14 hours from UTC


def _bad(message: str) -> AppError:
    return AppError(message, 422, kind=BAD_PERIOD)


def _zone(tz: str | None, tzo: str | None) -> tzinfo:
    # fullmatch: "$" would let a final newline through, and a zone name ending in one.
    if tz is not None and not _ZONE.fullmatch(tz):
        raise _bad("That time zone cannot be read.")
    offset = None
    if tzo is not None:
        try:
            offset = int(tzo)
        except ValueError:
            raise _bad("That offset cannot be read.") from None
        if not -_OFFSET_MAX <= offset <= _OFFSET_MAX:
            raise _bad("That offset is out of bounds.")
    return periods.zone(tz, offset)


def _day(value: str | None) -> date | None:
    if value is None:
        return None
    try:
        day = date.fromisoformat(value)
    except ValueError:
        raise _bad("That day cannot be read.") from None
    if not periods.FIRST_DAY <= day <= periods.LAST_DAY:
        raise _bad("That day is out of bounds.")
    return day


async def _period(db: aiosqlite.Connection, first: str | None, last: str | None,
                  where: tzinfo) -> periods.Period:
    start, end = _day(first), _day(last) or periods.today(where)
    if start is not None and start > end:
        raise _bad("A period cannot end before it starts.")
    return periods.period(start, end, where, await repo.since(db))


@router.get("")
async def summary(first: str | None = Query(None, alias="from"),
                  last: str | None = Query(None, alias="to"), tz: str | None = None,
                  tzo: str | None = None, model: str | None = None,
                  db: aiosqlite.Connection = Depends(get_db)):
    period = await _period(db, first, last, _zone(tz, tzo))
    return await repo.summary(db, period, model)


@router.get("/detail")
async def detail(cut: Literal["model", "card", "conversation", "use"], key: str,
                 first: str | None = Query(None, alias="from"),
                 last: str | None = Query(None, alias="to"), tz: str | None = None,
                 tzo: str | None = None, db: aiosqlite.Connection = Depends(get_db)):
    period = await _period(db, first, last, _zone(tz, tzo))
    found = await repo.detail(db, cut, key, period)
    if found is None:
        raise NotFoundError("Nothing of that line was found.", "spending")
    return found


@router.get("/total")
async def total(model: str | None = None, card: str | None = None,
                conversation: str | None = None, days: Literal["30", "all"] = "all",
                tz: str | None = None, tzo: str | None = None,
                db: aiosqlite.Connection = Depends(get_db)):
    # None named is every call: the line under My AIs, at the weight of one total.
    if sum(key is not None for key in (model, card, conversation)) > 1:
        raise _bad("Name one AI, one character or one conversation, or none.")
    where, lo = _zone(tz, tzo), None
    if days == "30":
        # The 30 days a page means: today and the 29 before, from their local midnight.
        lo = periods.midnight(periods.today(where) - timedelta(days=29), where)
    return await repo.total(db, model=model, card=card, conversation=conversation, lo=lo)


@router.get("/export.csv")
async def export(first: str | None = Query(None, alias="from"),
                 last: str | None = Query(None, alias="to"), tz: str | None = None,
                 tzo: str | None = None):
    where = _zone(tz, tzo)
    start, end = _day(first), _day(last)
    if start is not None and end is not None and start > end:
        raise _bad("A period cannot end before it starts.")
    lo = periods.midnight(start, where) if start else None
    hi = periods.midnight(end + timedelta(days=1), where) if end else None
    name = f"evermind-spending-{periods.today(where).isoformat()}.csv"
    return StreamingResponse(
        (line.encode("utf-8") async for line in repo.export_rows(lo, hi)),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.delete("")
async def clear(before: str | None = None, tz: str | None = None, tzo: str | None = None,
                dry_run: bool = False, db: aiosqlite.Connection = Depends(get_db)):
    where, day = _zone(tz, tzo), _day(before)
    cut = periods.midnight(day, where) if day else None
    return await repo.clear(db, cut, dry_run=dry_run)


@router.post("/forget")
async def forget(payload: ForgetIn, db: aiosqlite.Connection = Depends(get_db)):
    forgotten = await repo.forget(db, payload.cut, payload.key)
    await db.commit()
    return {"forgotten": forgotten}
