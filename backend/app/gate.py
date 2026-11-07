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

Whether or not a password is set, the same middleware refuses the writes under
/api/ that a browser sent from a page of another origin.
Without a password it also answers only to host names it knows, which is what
stops a website from reaching Evermind through a name of its own.
"""

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import logging
import math
import re
import secrets
import socket
import sqlite3
import time
import unicodedata
from collections import deque
from datetime import UTC, datetime, timedelta

from starlette.datastructures import Headers
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import config
from .db import connect

logger = logging.getLogger(__name__)

SESSION_COOKIE = "evermind_session"
SESSION_DAYS = 30
TOUCH_EVERY = timedelta(days=1)
FAILURE_DELAY_S = 0.6
MAX_FAILURES = 10
FAILURE_WINDOW_S = 900
PUBLIC_API_PATHS = frozenset({"/api/health", "/api/gate"})
# A Host header as a browser writes it: a name, or an IPv6 address in square
# brackets, then a port if there is one. Anything with more to it is not a host,
# whatever it starts with.
_HOST = re.compile(r"(?:\[(?P<v6>[^\]]+)\]|(?P<name>[\w.-]+))(?::[0-9]+)?")

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


def machine_name() -> str:
    return socket.gethostname()


async def failure_pause() -> None:
    """Slows guessing down; the limiter is what stops it."""
    await asyncio.sleep(FAILURE_DELAY_S)


def _utf8(text: str) -> bytes:
    # A string from JSON can hold a lone surrogate, which strict UTF-8 refuses
    # to encode. Such a password has to come out as wrong, not as an error.
    return text.encode("utf-8", "surrogatepass")


def _password_bytes(password: str) -> bytes:
    # A phone keyboard and the editor the .env was written in may not encode
    # an accent the same way: one character (U+00E9), or "e" followed by a
    # combining accent (U+0301). Both have to be the same password.
    return _utf8(unicodedata.normalize("NFC", password))


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(_password_bytes(password), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R,
                            p=_SCRYPT_P, dklen=_SCRYPT_DKLEN)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: object) -> bool:
    """Recomputes with the parameters written in ``stored``, so that a digest
    made with other settings still checks. Anything unreadable is a mismatch,
    including a value that is not text, such as a BLOB in the TEXT column."""
    if not isinstance(stored, str):
        return False
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest, validate=True)
        if not expected:
            return False
        actual = hashlib.scrypt(_password_bytes(password),
                                salt=base64.b64decode(salt, validate=True),
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


async def _write(sql: str, params: tuple = ()) -> None:
    """Runs one statement on a connection of its own and commits it."""
    conn = await connect()
    try:
        await conn.execute(sql, params)
        await conn.commit()
    finally:
        await conn.close()


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
    """The password's digest and the open sessions, ``{token digest: last seen}``.

    Memory never holds a session the database does not: a new or moved
    session is kept in memory once it is written, and an ended one is dropped
    from memory before it is deleted. Each change awaits its write, and two
    changes interleaving could break that rule, so they take turns under the
    lock that loading takes too. A sign-in finishing while every device is
    being signed out would otherwise stay open, with nothing behind it, until
    a restart.
    """

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
        reads it before then: the middleware awaits this before it lets a
        request reach /api/, and a failure here fails the request rather than
        letting it through.
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

        scrypt is slow on purpose, so the password is checked in a thread:
        on the event loop, each attempt would hold up the replies being
        streamed meanwhile. The login route has already counted the attempt
        against the limit, since others can arrive while this one is checked.
        """
        if not self.enabled:
            return None
        if not await asyncio.to_thread(verify_password, password, self._password_hash):
            return None
        token = secrets.token_urlsafe(32)
        digest = token_digest(token)
        async with self._lock:
            current = now()
            await _write("INSERT INTO gate_sessions (token_hash, created_at, last_seen_at) "
                         "VALUES (?, ?, ?)", (digest, _stamp(current), _stamp(current)))
            self._sessions[digest] = current
        return token

    def check(self, token: str | None) -> bool:
        if not self.enabled or not token:
            return False
        seen = self._sessions.get(token_digest(token))
        return seen is not None and now() - seen <= _SESSION_LIFETIME

    def _due(self, digest: str) -> bool:
        """Whether a live session was last moved a day ago or more."""
        seen = self._sessions.get(digest)
        return seen is not None and TOUCH_EVERY <= now() - seen <= _SESSION_LIFETIME

    async def touch(self, token: str) -> bool:
        """Moves a live session's last use to now, at most once a day. True
        means it moved and the cookie should be sent again, to slide too."""
        digest = token_digest(token)
        # Nearly every request stops here, without waiting for the lock.
        if not self._due(digest):
            return False
        async with self._lock:
            # Asked again now that it is this request's turn: the requests
            # arriving together on a new day all got past the first question,
            # and the session may have ended meanwhile.
            if not self._due(digest):
                return False
            current = now()
            try:
                await _write("UPDATE gate_sessions SET last_seen_at = ? WHERE token_hash = ?",
                             (_stamp(current), digest))
            except (sqlite3.Error, OSError) as error:
                # The session is still valid, so the request goes through.
                # Memory keeps the old date, so the next request tries again.
                logger.error("Could not record that a session was used: %s", error)
                return False
            self._sessions[digest] = current
        return True

    async def logout(self, token: str | None) -> None:
        if not token:
            return
        digest = token_digest(token)
        async with self._lock:
            # Every session whose token has been handed out is in memory, so
            # one that is not needs no write. Logging out is public, and a
            # stranger sending made-up cookies should not cost a write each.
            if self._sessions.pop(digest, None) is None:
                return
            await _write("DELETE FROM gate_sessions WHERE token_hash = ?", (digest,))

    async def logout_all(self) -> None:
        async with self._lock:
            self._sessions.clear()
            await _write("DELETE FROM gate_sessions")


def set_session_cookie(response: Response, token: str, *, secure: bool) -> None:
    """A cookie that outlives the browser (Max-Age), out of reach of scripts
    (HttpOnly), and left out of what pages of other sites send, a link to
    Evermind aside (SameSite=Lax). Another port of the same machine is the same
    site and still gets it sent, which is why GateMiddleware judges origins.
    Secure only when asked: a phone on http://192.168.x.y would never send it
    back."""
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, path="/",
                        secure=secure, httponly=True, samesite="lax")


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax")


def _from_another_origin(headers: Headers) -> bool:
    # Without the scheme: a proxy that ends https reaches this over http.
    origin = headers.get("origin")
    return origin is not None and origin.partition("://")[2].lower() != headers.get("host", "").lower()


def _host_name(host: str) -> str | None:
    """The name in a Host header: lowercase, without the port, the brackets
    around an IPv6 address, or a final dot. None when the header is anything but
    a host and, if there is one, a port: a name with something after it
    (``localhost:3000@evil.com``, ``localhost:evil.com``) must not pass for the
    name in front."""
    match = _HOST.fullmatch(host)
    if match is None:
        return None
    if (v6 := match["v6"]) is not None:
        try:
            ipaddress.IPv6Address(v6)
        except ValueError:
            return None
        return v6.lower()
    return match["name"].lower().removesuffix(".")


def _own_names() -> set[str]:
    """What this computer can be called by: the name the system gives it and,
    when that name carries a domain, its first label (``nas`` for
    ``nas.home.lan``, which is what people type), each alone or followed by
    .local."""
    machine = machine_name().lower()
    names = {machine, machine.partition(".")[0]} - {""}
    return names | {name + ".local" for name in names}


def _known_host(host: str) -> bool:
    """Whether a Host header names this computer in a way that a website
    cannot borrow: an address, localhost or a name ending in .localhost, the
    computer's own name (or its first label, if it has a domain), alone or
    followed by .local, or a name listed in EVERMIND_ALLOWED_HOSTS.

    A website can point a name of its own at 127.0.0.1 once its page is
    loaded (DNS rebinding). The browser then takes that page and Evermind for
    one origin, and only the Host header still shows the name it used. An
    address in the URL is no such trick, and the names above are not the
    website's to give out.
    """
    name = _host_name(host)
    if not name:
        return False
    try:
        ipaddress.ip_address(name)
    except ValueError:
        pass
    else:
        return True
    if name == "localhost" or name.endswith(".localhost"):
        return True
    if name in _own_names():
        return True
    # An entry that is not a host name is None here, and allows nothing.
    return name in map(_host_name, config.allowed_hosts())


def _host_refusal(host: str | None) -> str | None:
    """Why a password-less install refuses this Host header, or None when it is
    accepted. ``host`` is None when the request has no Host header at all."""
    if host is None:
        return "The request has no Host header."
    if not _known_host(host):
        return "Unknown host name. Add it to EVERMIND_ALLOWED_HOSTS or set a password."
    return None


async def _refuse(scope: Scope, receive: Receive, send: Send, status_code: int,
                  error: str, kind: str) -> None:
    response = JSONResponse({"error": error, "kind": kind}, status_code=status_code)
    await response(scope, receive, send)


def _session_cookie_header(token: str, *, secure: bool) -> bytes:
    """The header ``set_session_cookie`` writes, for a middleware that has no
    response object to call it on."""
    response = Response()
    set_session_cookie(response, token, secure=secure)
    return next(value for name, value in response.raw_headers if name == b"set-cookie")


class GateMiddleware:
    """Guards /api/. Password or not, it refuses the writes of pages from other
    origins. Without a password, it answers only to host names it knows; with
    one, only to a device with a session.

    Pure ASGI, so that a stream goes out as the app sends it.
    """

    def __init__(self, app: ASGIApp, store: GateStore) -> None:
        self.app = app
        self.store = store

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, send)
            return
        path = scope["path"]
        # Judged before the password, and whether or not there is one: without
        # it a forged write needs no session, and any website could send one
        # to an Evermind listening on localhost.
        if scope["method"] not in ("GET", "HEAD") and _from_another_origin(Headers(scope=scope)):
            await _refuse(scope, receive, send, 403, "Cross-origin request refused.",
                          "cross_origin")
            return
        store = self.store
        await store.ensure_loaded()
        if not store.enabled:
            # Reads included: a rebound page is same-origin, so the browser
            # would hand it the answers. With a password the name is left
            # alone, so that a proxy can serve Evermind under any name: the
            # session cookie belongs to the name a device signed in on, and a
            # rebound page has none.
            if refusal := _host_refusal(Headers(scope=scope).get("host")):
                await _refuse(scope, receive, send, 403, refusal, "unknown_host")
                return
            await self.app(scope, receive, send)
            return
        if path in PUBLIC_API_PATHS:
            await self.app(scope, receive, send)
            return

        token = HTTPConnection(scope).cookies.get(SESSION_COOKIE)
        if not store.check(token):
            await _refuse(scope, receive, send, 401, "Locked.", "locked")
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
