"""The access password. Off unless EVERMIND_GATE_PASSWORD is set; then everything
under /api/ except PUBLIC_PATHS needs a session cookie. Pages hold no data and
stay public, so that the interface can load and ask for the password.

The database keeps, per device, an HMAC of its random token keyed by the
password: a copy of it lets nobody in, and changing the password ends them all.

Password or not, a page of another origin cannot write. Without a password, the
API only answers to an address or localhost, which is what stops a website from
pointing a name of its own at this computer (DNS rebinding); with one, a page
under another name holds no cookie.
"""

import hashlib
import hmac
import ipaddress
import math
import secrets
import time
import unicodedata
from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

from . import config
from .db import connect

SESSION_COOKIE = "evermind_session"
COOKIE_MAX_AGE = 400 * 86400  # What browsers allow at most.
PUBLIC_PATHS = {"/api/health", "/api/gate"}
MAX_FAILURES = 10
FAILURE_WINDOW_S = 900

# Wrong passwords per address: how many, and since when.
_failures: dict[str, tuple[int, float]] = {}


def enabled() -> bool:
    return bool(config.gate_password())


def _utf8(text: str) -> bytes:
    # A phone and an editor may compose an accent differently, and JSON allows a lone surrogate.
    return unicodedata.normalize("NFC", text).encode("utf-8", "surrogatepass")


def _digest(text: str) -> str:
    return hmac.new(_utf8(config.gate_password()), _utf8(text), hashlib.sha256).hexdigest()


def password_matches(typed: str) -> bool:
    # Digests, so that the time taken says nothing of the length either.
    return hmac.compare_digest(_digest(typed), _digest(config.gate_password()))


def retry_after(address: str) -> int:
    """Seconds until ``address`` may try again; 0 if it may now."""
    count, start = _failures.get(address, (0, 0.0))
    left = start + FAILURE_WINDOW_S - time.monotonic()
    return math.ceil(left) if count >= MAX_FAILURES and left > 0 else 0


def count_failure(address: str) -> None:
    now = time.monotonic()
    # A window that has run out is forgotten, this address's too, which then starts a new one.
    for quiet in [a for a, (_, start) in _failures.items() if now - start >= FAILURE_WINDOW_S]:
        del _failures[quiet]
    count, start = _failures.get(address, (0, now))
    _failures[address] = (count + 1, start)


def forget_failures(address: str) -> None:
    _failures.pop(address, None)


async def _run(sql: str, *params: str) -> list:
    conn = await connect()
    try:
        rows = list(await conn.execute_fetchall(sql, params))
        await conn.commit()
        return rows
    finally:
        await conn.close()


async def open_session() -> str:
    token = secrets.token_urlsafe(32)
    await _run("INSERT INTO gate_sessions (token_hash) VALUES (?)", _digest(token))
    return token


async def session_is_open(token: str | None) -> bool:
    if not token or not enabled():
        return False
    return bool(await _run("SELECT 1 FROM gate_sessions WHERE token_hash = ?", _digest(token)))


async def end_session(token: str | None) -> None:
    if token and enabled():
        await _run("DELETE FROM gate_sessions WHERE token_hash = ?", _digest(token))


async def end_all_sessions() -> None:
    await _run("DELETE FROM gate_sessions")


def _from_another_origin(headers: Headers) -> bool:
    # Without the scheme: a proxy that ends https reaches this over http.
    origin = headers.get("origin")
    host = headers.get("host", "")
    return origin is not None and origin.partition("://")[2].lower() != host.lower()


def _named_by_address(host: str) -> bool:
    try:
        name = urlsplit("//" + host).hostname or ""
        return name == "localhost" or bool(ipaddress.ip_address(name))
    except ValueError:
        return False


async def _refusal(scope: Scope) -> Response | None:
    headers = Headers(scope=scope)
    if scope["method"] not in ("GET", "HEAD") and _from_another_origin(headers):
        return JSONResponse({"error": "Cross-origin request refused.", "kind": "cross_origin"}, 403)
    if not enabled():
        if _named_by_address(headers.get("host", "")):
            return None
        return JSONResponse({"error": "Unknown host name. Open Evermind by its address, or set "
                             "a password.", "kind": "unknown_host"}, 403)
    token = HTTPConnection(scope).cookies.get(SESSION_COOKIE)
    if scope["path"] in PUBLIC_PATHS or await session_is_open(token):
        return None
    return JSONResponse({"error": "Locked.", "kind": "locked"}, 401)


class GateMiddleware:
    """Pure ASGI, so that a stream goes out as the app sends it."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        refusal = None
        if scope["type"] == "http" and scope["path"].startswith("/api/"):
            refusal = await _refusal(scope)
        await (refusal or self.app)(scope, receive, send)
