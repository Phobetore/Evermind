"""The device's days as instants. Rows are written in UTC; a period is asked in the days of the
page's own zone, so that a call at half past eleven in Paris falls on that day there, and the day
the clocks go back has its 25 hours."""

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone, tzinfo
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .calls import instant

# Up to a month goes by day; beyond, a day would be too thin a bar on a phone.
DAYS_BY_DAY = 31
# The days a period may name. No call is older than 2000 nor will be after 2100; beyond, a date
# overflows, or its weeks are more bounds than SQLite takes in one query.
FIRST_DAY, LAST_DAY = date(2000, 1, 1), date(2100, 12, 31)


@dataclass(frozen=True)
class Period:
    lo: str
    hi: str                                    # excluded
    days: int                                  # its length in local days
    previous: tuple[str, str] | None           # as many days just before; None from the start
    step: Literal["day", "week"]
    buckets: list[tuple[str, str, str]]        # (local date of the bucket's start, lo, hi)


def zone(tz: str | None, tzo: int | None) -> tzinfo:
    """The page's zone when Python knows its name; else the offset the page gave, in minutes east
    of UTC; else UTC."""
    if tz:
        try:
            return ZoneInfo(tz)
        # OSError: a folder of the zone base ("America") or a name the system cannot open is
        # no zone either.
        except (ZoneInfoNotFoundError, ValueError, OSError):
            pass
    if tzo is not None:
        return timezone(timedelta(minutes=tzo))
    return UTC


def midnight(day: date, where: tzinfo) -> str:
    """That local midnight as an instant."""
    return instant(datetime(day.year, day.month, day.day, tzinfo=where))


def today(where: tzinfo) -> date:
    return datetime.now(where).date()


def period(first: date | None, last: date, where: tzinfo, since: str) -> Period:
    """From ``first`` to ``last``, both whole local days. ``first`` None: from the local day of
    ``since``, with no period before it to compare with. Weeks start on Monday, the first one on
    the Monday on or before ``first``; the first and the last are cut to the period, so that the
    bars add up to its total."""
    everything = first is None
    if first is None:
        first = datetime.fromisoformat(since).astimezone(where).date()
    first = min(first, last)
    days = (last - first).days + 1
    lo, hi = midnight(first, where), midnight(last + timedelta(days=1), where)
    previous = None if everything else (midnight(first - timedelta(days=days), where), lo)
    if days <= DAYS_BY_DAY:
        buckets = [(day.isoformat(), midnight(day, where), midnight(day + timedelta(days=1), where))
                   for day in (first + timedelta(days=n) for n in range(days))]
        return Period(lo, hi, days, previous, "day", buckets)
    buckets = []
    monday = first - timedelta(days=first.weekday())
    while monday <= last:
        start, end = max(monday, first), min(monday + timedelta(days=7), last + timedelta(days=1))
        buckets.append((monday.isoformat(), midnight(start, where), midnight(end, where)))
        monday += timedelta(days=7)
    return Period(lo, hi, days, previous, "week", buckets)
