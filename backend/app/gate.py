"""The access password: one session per device, kept by the server.

Off unless EVERMIND_GATE_PASSWORD is set. When it is, everything under /api/
except PUBLIC_API_PATHS needs a session cookie, and pages stay public so that
the interface can load and ask for the password.

The cookie holds a random token and the database only a SHA-256 digest of it,
so a copy of the database lets nobody in. The password is kept as a scrypt
digest, which is what lets the next start tell whether it has changed: a
different password revokes every session opened with the old one.

Sessions are checked against memory on every API request and written through
to the database. That is only right with a single process, which is how
Evermind runs.
"""

import asyncio
import base64
import hashlib
import hmac
import math
import secrets
import time
from collections import deque
from datetime import UTC, datetime, timedelta

from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import config
from .db import connect

SESSION_COOKIE = "evermind_session"
SESSION_DAYS = 30
TOUCH_EVERY = timedelta(days=1)
FAILURE_DELAY_S = 0.6
MAX_FAILURES = 10
FAILURE_WINDOW_S = 900
PUBLIC_API_PATHS = frozenset({"/api/health", "/api/gate"})

_SCRYPT_N = 16384
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32
_SESSION_LIFETIME = timedelta(days=SESSION_DAYS)
_COOKIE_PREFIX = SESSION_COOKIE.encode() + b"="


def now() -> datetime:
    return datetime.now(UTC)


def monotonic() -> float:
    return time.monotonic()


async def failure_pause() -> None:
    """Slows guessing down; the limiter is what stops it."""
    await asyncio.sleep(FAILURE_DELAY_S)


def _utf8(text: str) -> bytes:
    # A string from JSON can hold a lone surrogate, which strict UTF-8 refuses
    # to encode. Such a password has to come out as wrong, not as an error.
    return text.encode("utf-8", "surrogatepass")


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(_utf8(password), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R,
                            p=_SCRYPT_P, dklen=_SCRYPT_DKLEN)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    """Recomputes with the parameters written in ``stored``, so that a digest
    made with other settings still checks. Anything unreadable is a mismatch."""
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest, validate=True)
        if not expected:
            return False
        actual = hashlib.scrypt(_utf8(password), salt=base64.b64decode(salt, validate=True),
                                n=int(n), r=int(r), p=int(p), dklen=len(expected))
    except (ValueError, OverflowError, TypeError):
        # binascii.Error is a ValueError; so is what scrypt raises for
        # parameters it refuses or that would need too much memory. A number
        # too large for a C long is a TypeError, at least on Windows.
        return False
    return hmac.compare_digest(actual, expected)


def token_digest(token: str) -> str:
    return hashlib.sha256(_utf8(token)).hexdigest()


def _stamp(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="seconds")


def _parse_stamp(value: str) -> datetime | None:
    try:
        moment = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


class AttemptLimiter:
    """Failed attempts per key, over a sliding window of FAILURE_WINDOW_S."""

    def __init__(self) -> None:
        self._failures: dict[str, deque[float]] = {}

    def _recent(self, key: str, current: float) -> deque[float] | None:
        times = self._failures.get(key)
        if times is None:
            return None
        while times and current - times[0] >= FAILURE_WINDOW_S:
            times.popleft()
        if not times:
            del self._failures[key]
            return None
        return times

    def retry_after(self, key: str) -> int:
        """Seconds until ``key`` may try again; 0 if it may now."""
        current = monotonic()
        times = self._recent(key, current)
        if times is None or len(times) < MAX_FAILURES:
            return 0
        return max(1, math.ceil(times[0] + FAILURE_WINDOW_S - current))

    def record_failure(self, key: str) -> None:
        current = monotonic()
        # Forget the addresses that have gone quiet, so that the table does not
        # grow with every address that ever got the password wrong.
        for quiet in [k for k, t in self._failures.items() if current - t[-1] >= FAILURE_WINDOW_S]:
            del self._failures[quiet]
        self._failures.setdefault(key, deque(maxlen=MAX_FAILURES)).append(current)

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)


class GateStore:
    """The password's digest and the open sessions, ``{token digest: last seen}``."""

    def __init__(self) -> None:
        self.enabled = False
        self.limiter = AttemptLimiter()
        self._loaded = False
        self._lock = asyncio.Lock()
        self._password_hash = ""
        self._sessions: dict[str, datetime] = {}

    async def ensure_loaded(self) -> None:
        """Reads the password and the sessions once, on the first request.

        Until this has succeeded the store says it is disabled, but nothing
        reads it before then: the middleware awaits this first, and a failure
        here fails the request rather than letting it through.
        """
        if self._loaded:
            return
        async with self._lock:
            if self._loaded:
                return
            await self._load(config.gate_password())
            self._loaded = True

    async def _load(self, password: str) -> None:
        conn = await connect()
        try:
            if not password:
                # Turning the password off ends every session, so that turning
                # it back on later does not quietly let in a device from before.
                await conn.execute("DELETE FROM gate_sessions")
                await conn.execute("DELETE FROM gate_state")
                await conn.commit()
                self.enabled = False
                self._password_hash = ""
                self._sessions = {}
                return

            row = await (await conn.execute(
                "SELECT password_hash FROM gate_state WHERE id = 1")).fetchone()
            stored = row["password_hash"] if row else None
            if stored is None or not verify_password(password, stored):
                stored = hash_password(password)
                await conn.execute("DELETE FROM gate_sessions")
                await conn.execute(
                    "INSERT INTO gate_state (id, password_hash) VALUES (1, ?) "
                    "ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash",
                    (stored,),
                )

            current = now()
            sessions: dict[str, datetime] = {}
            expired: list[tuple[str]] = []
            for session in await conn.execute_fetchall(
                    "SELECT token_hash, last_seen_at FROM gate_sessions"):
                seen = _parse_stamp(session["last_seen_at"])
                if seen is None or current - seen > _SESSION_LIFETIME:
                    expired.append((session["token_hash"],))
                else:
                    sessions[session["token_hash"]] = seen
            if expired:
                await conn.executemany("DELETE FROM gate_sessions WHERE token_hash = ?", expired)
            await conn.commit()
        finally:
            await conn.close()
        self._password_hash = stored
        self._sessions = sessions
        self.enabled = True

    async def login(self, password: str) -> str | None:
        """A new session's token, or None if the password is wrong.

        Nothing awaits on the way to None. The login route checks the limiter,
        calls this and records the failure as one uninterrupted step, which is
        what keeps attempts sent all at once from slipping past the limit.
        """
        if not self.enabled or not verify_password(password, self._password_hash):
            return None
        token = secrets.token_urlsafe(32)
        digest = token_digest(token)
        current = now()
        conn = await connect()
        try:
            await conn.execute(
                "INSERT INTO gate_sessions (token_hash, created_at, last_seen_at) "
                "VALUES (?, ?, ?)",
                (digest, _stamp(current), _stamp(current)),
            )
            await conn.commit()
        finally:
            await conn.close()
        self._sessions[digest] = current
        return token

    def check(self, token: str | None) -> bool:
        if not self.enabled or not token:
            return False
        seen = self._sessions.get(token_digest(token))
        return seen is not None and now() - seen <= _SESSION_LIFETIME

    async def touch(self, token: str) -> bool:
        """Moves a live session's last use to now, at most once a day. True
        means it moved and the cookie should be sent again, to slide too."""
        digest = token_digest(token)
        seen = self._sessions.get(digest)
        current = now()
        if seen is None or current - seen > _SESSION_LIFETIME or current - seen < TOUCH_EVERY:
            return False
        # Memory first, before anything awaits, so that the requests arriving
        # together on a new day do not all write it.
        self._sessions[digest] = current
        conn = await connect()
        try:
            await conn.execute("UPDATE gate_sessions SET last_seen_at = ? WHERE token_hash = ?",
                               (_stamp(current), digest))
            await conn.commit()
        finally:
            await conn.close()
        return True

    async def logout(self, token: str | None) -> None:
        if not token:
            return
        digest = token_digest(token)
        # Every session whose token has been handed out is in memory, so one
        # that is not needs no write. Logging out is public, and a stranger
        # sending made-up cookies should not cost a database write each.
        if self._sessions.pop(digest, None) is None:
            return
        conn = await connect()
        try:
            await conn.execute("DELETE FROM gate_sessions WHERE token_hash = ?", (digest,))
            await conn.commit()
        finally:
            await conn.close()

    async def logout_all(self) -> None:
        self._sessions.clear()
        conn = await connect()
        try:
            await conn.execute("DELETE FROM gate_sessions")
            await conn.commit()
        finally:
            await conn.close()


def set_session_cookie(response: Response, token: str, *, secure: bool) -> None:
    """A cookie that outlives the browser (Max-Age), sent only by this site's
    own pages (SameSite=Lax) and out of reach of scripts (HttpOnly). Secure only
    when asked: a phone on http://192.168.x.y would never send it back."""
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, path="/",
                        secure=secure, httponly=True, samesite="lax")


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax")


def _route_path(scope: Scope) -> str:
    """The path the router will match, which is the one to judge.

    Under a root path (``uvicorn --root-path /evermind``, for a proxy that
    serves Evermind under a prefix), ``scope["path"]`` starts with it and
    Starlette routes on what follows. Judging ``scope["path"]`` itself would
    leave all of /evermind/api/ open. This follows Starlette's own rule.
    """
    path = scope["path"]
    root = scope.get("root_path", "")
    if root and path.startswith(root) and path[len(root):len(root) + 1] in ("", "/"):
        return path[len(root):]
    return path


def _session_cookie_header(token: str, *, secure: bool) -> bytes:
    """The header ``set_session_cookie`` writes, for a middleware that has no
    response object to call it on."""
    response = Response()
    set_session_cookie(response, token, secure=secure)
    return next(value for name, value in response.raw_headers if name == b"set-cookie")


class GateMiddleware:
    """Locks /api/ behind a session.

    Pure ASGI on purpose: BaseHTTPMiddleware would sit between the app and the
    client on every response, and a reply still being written (the stream of
    a turn) has to reach the client as it comes.
    """

    def __init__(self, app: ASGIApp, store: GateStore) -> None:
        self.app = app
        self.store = store

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        store = self.store
        await store.ensure_loaded()
        path = _route_path(scope)
        if not store.enabled or not path.startswith("/api/") or path in PUBLIC_API_PATHS:
            await self.app(scope, receive, send)
            return

        token = HTTPConnection(scope).cookies.get(SESSION_COOKIE)
        if not store.check(token):
            locked = JSONResponse({"error": "Locked.", "kind": "locked"}, status_code=401)
            await locked(scope, receive, send)
            return
        if not await store.touch(token):
            await self.app(scope, receive, send)
            return

        reissued = _session_cookie_header(token, secure=scope.get("scheme") == "https")

        async def send_reissued(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", ()))
                # A response that sets the cookie itself, such as the one that
                # clears it after logging out everywhere, has the last word:
                # adding ours after it would bring the cookie back.
                if not any(name.lower() == b"set-cookie" and value.startswith(_COOKIE_PREFIX)
                           for name, value in headers):
                    headers.append((b"set-cookie", reissued))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_reissued)
