"""Asks GitHub whether a newer release exists.

Nothing leaves the machine but the request itself: no instance identifier, no
usage, nothing about what is installed. The answer is cached for a day, so a
settings page opened twenty times in an afternoon still costs one request, and
every failure is reported as "no news" rather than an error, because a release
check is not worth breaking a page over.
"""

import asyncio
import os
import time
from pathlib import Path

import httpx

from .. import __version__

_LATEST_RELEASE = "https://api.github.com/repos/Phobetore/Evermind/releases/latest"
_CACHE_SECONDS = 60 * 60 * 24
_TIMEOUT = 5.0

_cached: tuple[float, dict | None] | None = None
_lock = asyncio.Lock()


def _as_numbers(version: str) -> tuple[int, ...] | None:
    """``v2.0.7`` becomes ``(2, 0, 7)``. Anything that is not plain dotted
    numbers returns None, release candidates and build tags included, so
    nobody is ever pointed at something that was not a release."""
    parts = version.lstrip("vV").split(".")
    if not parts or not all(part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def is_newer(candidate: str, current: str) -> bool:
    left, right = _as_numbers(candidate), _as_numbers(current)
    return bool(left and right and left > right)


def install_kind() -> str:
    """Which upgrade instructions to offer. Docker writes this file into every
    container it starts; a source checkout has no equivalent to look for."""
    return "docker" if Path("/.dockerenv").exists() else "source"


def upgrade_command() -> str:
    """The exact line to run. It depends on how Evermind was installed and on
    what shell the host is likely to have, neither of which the browser can
    work out on its own."""
    if install_kind() == "docker":
        return "docker compose pull && docker compose up -d"
    if os.name == "nt":
        # Windows PowerShell has no && operator; it is a parse error there.
        return r"git pull; .\scripts\prod.ps1"
    return "git pull && ./scripts/prod.sh"


async def _fetch() -> dict | None:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.get(
            _LATEST_RELEASE, headers={"Accept": "application/vnd.github+json"}
        )
    response.raise_for_status()
    body = response.json()
    tag = body.get("tag_name")
    if not isinstance(tag, str) or not tag:
        return None
    url = body.get("html_url")
    return {"tag": tag, "url": url if isinstance(url, str) else None}


async def _latest_release() -> dict | None:
    global _cached
    async with _lock:
        now = time.monotonic()
        if _cached and now - _cached[0] < _CACHE_SECONDS:
            return _cached[1]
        try:
            release = await _fetch()
        except (httpx.HTTPError, OSError, ValueError):
            # Offline, rate-limited, GitHub down, a proxy in the way, or an
            # answer that is not JSON. Cache the silence too, so an unreachable
            # network is not retried on every single page load. Anything
            # outside this set is a bug here and should not be swallowed.
            release = None
        _cached = (now, release)
        return release


async def check(*, enabled: bool) -> dict:
    answer = {
        "current": __version__,
        "latest": None,
        "url": None,
        "update_available": False,
        "install": install_kind(),
        "command": upgrade_command(),
        "enabled": enabled,
    }
    if not enabled:
        return answer
    release = await _latest_release()
    if not release:
        return answer
    tag = release["tag"]
    answer["latest"] = tag.lstrip("vV")
    answer["url"] = release["url"]
    answer["update_available"] = is_newer(tag, __version__)
    return answer
