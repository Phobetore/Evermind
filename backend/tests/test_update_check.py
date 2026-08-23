import pytest

from app import __version__
from app.services import update_check


@pytest.fixture(autouse=True)
def cold_cache(monkeypatch):
    """The cache is module state, so without this a test would inherit whatever
    the previous one left there. monkeypatch puts it back afterwards."""
    monkeypatch.setattr(update_check, "_cached", None)


@pytest.mark.parametrize(
    ("candidate", "current", "expected"),
    [
        ("v2.0.8", "2.0.7", True),
        ("2.0.8", "2.0.7", True),
        ("v2.1.0", "2.0.9", True),
        ("v3.0.0", "2.9.9", True),
        ("v2.0.7", "2.0.7", False),
        ("v2.0.6", "2.0.7", False),
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
