import pytest

from app import __version__
from app.services import update_check


@pytest.fixture(autouse=True)
def cold_cache(monkeypatch):
    """The cache is module state, so without this a test would inherit whatever
    the previous one left there. monkeypatch puts it back afterwards."""
    monkeypatch.setattr(update_check, "_cache", update_check._Cache())


@pytest.mark.parametrize(
    ("candidate", "current", "expected"),
    [
        ("v2.0.8", "2.0.7", True),
        ("2.0.8", "2.0.7", True),
        ("v2.1.0", "2.0.9", True),
        ("v3.0.0", "2.9.9", True),
        ("v2.0.7", "2.0.7", False),
        ("v2.0.6", "2.0.7", False),
        # Compared as numbers, not as text. As text "2.0.10" sorts before
        # "2.0.9", which would have stopped the notification dead at the first
        # two-digit patch.
        ("v2.0.10", "2.0.9", True),
        ("v2.0.9", "2.0.10", False),
        ("v2.10.0", "2.9.0", True),
        # Nothing that is not a plain release may read as newer, or people get
        # told to update to something that was never released.
        ("v2.0.8-rc1", "2.0.7", False),
        ("0.0.1-assettest", "2.0.7", False),
        ("v2.0.8+build9", "2.0.7", False),
        ("nightly", "2.0.7", False),
        ("", "2.0.7", False),
    ],
)
def test_is_newer(candidate, current, expected):
    assert update_check.is_newer(candidate, current) is expected


async def test_nothing_goes_out_when_the_check_is_off(monkeypatch):
    """The whole point of the switch: turning it off has to mean no request,
    not a request whose answer is discarded."""

    async def explode():
        raise AssertionError("a request went out with the check turned off")

    monkeypatch.setattr(update_check, "_fetch", explode)
    answer = await update_check.check(enabled=False)
    assert answer["enabled"] is False
    assert answer["update_available"] is False
    assert answer["latest"] is None
    assert answer["current"] == __version__


async def test_a_newer_release_is_reported(monkeypatch):
    async def fake():
        return {"tag": "v99.0.0", "url": "https://example.invalid/releases/v99.0.0"}

    monkeypatch.setattr(update_check, "_fetch", fake)
    answer = await update_check.check(enabled=True)
    assert answer["update_available"] is True
    assert answer["latest"] == "99.0.0"
    assert answer["url"] == "https://example.invalid/releases/v99.0.0"


async def test_the_release_you_are_running_is_not_an_update(monkeypatch):
    async def fake():
        return {"tag": f"v{__version__}", "url": "https://example.invalid"}

    monkeypatch.setattr(update_check, "_fetch", fake)
    answer = await update_check.check(enabled=True)
    assert answer["latest"] == __version__
    assert answer["update_available"] is False


async def test_a_failure_answers_no_news(monkeypatch):
    """Offline, rate-limited, proxied, GitHub down. None of it may surface as
    an error on a settings page."""

    async def fake():
        raise OSError("no route to host")

    monkeypatch.setattr(update_check, "_fetch", fake)
    answer = await update_check.check(enabled=True)
    assert answer["update_available"] is False
    assert answer["latest"] is None
    assert answer["current"] == __version__


async def test_the_answer_is_cached(monkeypatch):
    calls = []

    async def fake():
        calls.append(1)
        return {"tag": "v99.0.0", "url": None}

    monkeypatch.setattr(update_check, "_fetch", fake)
    for _ in range(5):
        await update_check.check(enabled=True)
    assert len(calls) == 1, f"asked GitHub {len(calls)} times for one day's answer"


async def test_a_failed_lookup_is_remembered_too(monkeypatch):
    """Otherwise an unreachable network is retried on every single page load.
    Remembering the failure is why the cache tracks whether it holds an answer
    apart from what that answer was: a kept None and never having asked would
    otherwise look the same."""
    calls = []

    async def fake():
        calls.append(1)
        raise OSError("no route to host")

    monkeypatch.setattr(update_check, "_fetch", fake)
    for _ in range(4):
        answer = await update_check.check(enabled=True)
        assert answer["reachable"] is False
    assert len(calls) == 1, f"retried an unreachable network {len(calls)} times"


async def test_a_refresh_looks_past_the_cached_answer(monkeypatch):
    """The cache is what keeps a settings page from costing a request every
    time it opens. Pressing the button is a different thing being asked."""
    calls = []

    async def fake():
        calls.append(1)
        return {"tag": "v99.0.0", "url": None}

    monkeypatch.setattr(update_check, "_fetch", fake)
    await update_check.check(enabled=True)
    await update_check.check(enabled=True)
    assert len(calls) == 1, "the second page load should have used the cache"

    await update_check.check(enabled=True, refresh=True)
    assert len(calls) == 2, "the button should have asked again"


async def test_a_refresh_asks_even_with_the_daily_check_off(monkeypatch):
    """Off means "do not do this on your own". Pressing the button is the
    asking, so it would be wrong to answer it with silence."""

    async def fake():
        return {"tag": "v99.0.0", "url": None}

    monkeypatch.setattr(update_check, "_fetch", fake)
    answer = await update_check.check(enabled=False, refresh=True)
    assert answer["reachable"] is True
    assert answer["update_available"] is True
    assert answer["enabled"] is False, "the switch itself must not be flipped by it"


async def test_an_unreachable_check_says_so_rather_than_no_news(monkeypatch):
    """A page load can treat silence as no news. Someone who pressed a button
    is owed the difference between "nothing new" and "could not ask"."""

    async def fake():
        raise OSError("no route to host")

    monkeypatch.setattr(update_check, "_fetch", fake)
    answer = await update_check.check(enabled=True, refresh=True)
    assert answer["reachable"] is False
    assert answer["update_available"] is False


async def test_being_up_to_date_is_not_the_same_as_unreachable(monkeypatch):
    async def fake():
        return {"tag": f"v{__version__}", "url": None}

    monkeypatch.setattr(update_check, "_fetch", fake)
    answer = await update_check.check(enabled=True, refresh=True)
    assert answer["reachable"] is True, "GitHub answered; there is simply nothing newer"
    assert answer["update_available"] is False


async def test_endpoint_refreshes_on_request(client, monkeypatch):
    calls = []

    async def fake():
        calls.append(1)
        return {"tag": "v99.0.0", "url": None}

    monkeypatch.setattr(update_check, "_fetch", fake)
    await client.get("/api/update")
    await client.get("/api/update")
    assert len(calls) == 1

    body = (await client.get("/api/update?refresh=true")).json()
    assert len(calls) == 2
    assert body["reachable"] is True


async def test_endpoint_follows_the_setting(client, monkeypatch):
    async def fake():
        return {"tag": "v99.0.0", "url": "https://example.invalid"}

    monkeypatch.setattr(update_check, "_fetch", fake)

    body = (await client.get("/api/update")).json()
    assert body["update_available"] is True
    assert body["install"] in ("docker", "source")

    assert (await client.put("/api/settings", json={"update_check": False})).status_code == 200
    body = (await client.get("/api/update")).json()
    assert body["enabled"] is False
    assert body["update_available"] is False
