"""The device's days as instants: a period is asked in the days of the page's own zone, and the
rows are written in UTC."""

from datetime import date, datetime, timedelta, timezone

from app.services import periods

PARIS = periods.zone("Europe/Paris", None)
SINCE = "2026-01-01T00:00:00.000+00:00"


def hours(lo: str, hi: str) -> float:
    return (datetime.fromisoformat(hi) - datetime.fromisoformat(lo)) / timedelta(hours=1)


def test_thirty_days_start_at_the_local_midnight_29_days_ago():
    today = date(2026, 11, 25)
    p = periods.period(today - timedelta(days=29), today, PARIS, SINCE)
    assert p.lo == "2026-10-26T23:00:00.000+00:00"
    assert p.hi == "2026-11-25T23:00:00.000+00:00"
    assert (p.days, p.step, len(p.buckets)) == (30, "day", 30)
    assert p.buckets[0] == ("2026-10-27", p.lo, "2026-10-27T23:00:00.000+00:00")
    assert p.buckets[-1][2] == p.hi


def test_the_day_the_clocks_go_back_has_25_hours():
    day = date(2026, 10, 25)
    p = periods.period(day, day, PARIS, SINCE)
    assert hours(p.lo, p.hi) == 25
    [(start, lo, hi)] = p.buckets
    assert (start, hours(lo, hi)) == ("2026-10-25", 25)


def test_an_unknown_zone_takes_the_page_offset():
    where = periods.zone("Mars/Base", 60)
    assert where.utcoffset(None) == timedelta(hours=1)
    assert periods.midnight(date(2026, 11, 25), where) == "2026-11-24T23:00:00.000+00:00"
    # Neither a zone nor an offset: UTC.
    assert periods.zone(None, None).utcoffset(None) == timedelta(0)
    assert periods.zone("Mars/Base", None).utcoffset(None) == timedelta(0)
    # A known zone wins over the offset.
    assert periods.zone("Asia/Tokyo", 60).utcoffset(datetime(2026, 1, 1)) == timedelta(hours=9)


def test_more_than_31_days_go_by_weeks_from_a_monday():
    first, last = date(2026, 9, 10), date(2026, 11, 25)  # a Thursday, a Wednesday
    p = periods.period(first, last, PARIS, SINCE)
    assert p.step == "week"
    starts = [start for start, _, _ in p.buckets]
    assert starts[0] == "2026-09-07"  # the Monday on or before the first day
    assert all(date.fromisoformat(s).weekday() == 0 for s in starts)
    assert starts[-1] == "2026-11-23"
    # The buckets cover the period and nothing outside it, one after the other.
    assert (p.buckets[0][1], p.buckets[-1][2]) == (p.lo, p.hi)
    assert all(a[2] == b[1] for a, b in zip(p.buckets, p.buckets[1:], strict=False))
    # 31 days still go by day.
    assert periods.period(date(2026, 10, 1), date(2026, 10, 31), PARIS, SINCE).step == "day"


def test_the_previous_period_has_as_many_days():
    p = periods.period(date(2026, 11, 1), date(2026, 11, 25), PARIS, SINCE)
    assert p.days == 25
    assert p.previous == (periods.midnight(date(2026, 10, 7), PARIS), p.lo)


def test_from_the_beginning_starts_on_the_day_of_since_and_has_no_previous():
    since = "2026-11-20T23:30:00.000+00:00"  # the 21st in Paris
    p = periods.period(None, date(2026, 11, 25), PARIS, since)
    assert p.lo == periods.midnight(date(2026, 11, 21), PARIS)
    assert (p.days, p.previous) == (5, None)


def test_today_is_the_zone_s_own_day():
    tokyo = periods.zone(None, 14 * 60)
    assert periods.today(tokyo) == datetime.now(timezone(timedelta(hours=14))).date()
