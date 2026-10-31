"""The access password, kept by the backend.

One session per device, of which the database only holds a digest; failed
attempts slowed down and limited per address; a logout that the server
honours. Many people reach Evermind from a phone over plain HTTP on a LAN
address, so the cookie has to work without the Secure flag there.
"""

import asyncio
import unicodedata
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from starlette.websockets import WebSocket

from app import gate
from app.db import connect

PW = "s3cret"
COOKIE = gate.SESSION_COOKIE


@pytest.fixture()
def clock(monkeypatch):
    """Both of the gate's clocks, moved only by the test."""

    class Clock:
        def __init__(self) -> None:
            self.wall = datetime.now(UTC)
            self.mono = 1000.0

        def advance(self, **delta: float) -> None:
            step = timedelta(**delta)
            self.wall += step
            self.mono += step.total_seconds()

    c = Clock()
    monkeypatch.setattr(gate, "now", lambda: c.wall)
    monkeypatch.setattr(gate, "monotonic", lambda: c.mono)
    return c


@pytest.fixture()
def pauses(monkeypatch):
    """Records the pause after a wrong password instead of sleeping through it."""
    calls: list[None] = []

    async def pause() -> None:
        calls.append(None)

    monkeypatch.setattr(gate, "failure_pause", pause)
    return calls


async def sign_in(c, password: str = PW) -> str:
    """Log in as a new device and return its token. The client's cookie jar is
    left empty, so that every later request says which device it comes from."""
    r = await c.post("/api/gate", json={"password": password})
    assert r.status_code == 204, r.text
    token = r.cookies[COOKIE]
    c.cookies.clear()
    return token


def device(token: str) -> dict:
    return {"cookie": f"{COOKIE}={token}"}


def attributes(set_cookie: str) -> list[str]:
    """The attributes after the value, lowercased: the token itself is random
    and could spell anything."""
    return [part.strip().lower() for part in set_cookie.split(";")[1:]]


async def rows(sql: str) -> list:
    conn = await connect()
    try:
        return list(await conn.execute_fetchall(sql))
    finally:
        await conn.close()


async def test_gate_is_off_without_password(client):
    assert (await client.get("/api/characters")).status_code == 200
    assert (await client.get("/api/gate")).json() == {"enabled": False, "authenticated": False}


async def test_login_is_a_no_op_without_password(client):
    r = await client.post("/api/gate", json={"password": "anything"})
    assert r.status_code == 204
    assert "set-cookie" not in r.headers


@pytest.mark.parametrize("path", ["/api/characters", "/api/media/x.png", "/api/library",
                                  "/api/conversations/x/turn/stream", "/api/gate/sessions"])
async def test_api_and_media_are_locked_without_session(make_client, path):
    method = "DELETE" if path == "/api/gate/sessions" else "GET"
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.request(method, path)
    assert r.status_code == 401
    assert r.json() == {"error": "Locked.", "kind": "locked"}


async def test_a_root_path_does_not_open_the_api(make_client):
    """Behind a proxy that serves Evermind under a prefix, the path the router
    matches is the one without it, and that is the one the gate must judge."""
    from app.main import create_app

    async with make_client(EVERMIND_GATE_PASSWORD=PW):
        transport = httpx.ASGITransport(app=create_app(), root_path="/evermind")
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as prefixed:
            r = await prefixed.get("/evermind/api/characters")
            assert r.status_code == 401
            assert (await prefixed.get("/evermind/api/health")).status_code == 200


def socket_app():
    """An application with one websocket under /api/. The API has none today,
    and the gate must not be relying on that."""
    from app.main import create_app

    app = create_app()

    @app.websocket("/api/socket")
    async def hello(websocket: WebSocket) -> None:
        await websocket.accept()
        await websocket.send_text("hello")
        await websocket.close()

    return app


async def open_socket(app, headers: dict) -> list[str]:
    """Opens /api/socket the way a server would, and returns the type of each
    message the application sent back, with the code of a close."""
    sent: list[str] = []

    async def receive() -> dict:
        return {"type": "websocket.connect"}

    async def send(message: dict) -> None:
        kind = message["type"]
        sent.append(f"{kind} {message.get('code', 1000)}" if kind == "websocket.close" else kind)

    scope = {"type": "websocket", "asgi": {"version": "3.0"}, "scheme": "ws",
             "path": "/api/socket", "raw_path": b"/api/socket", "root_path": "",
             "query_string": b"", "client": ("127.0.0.1", 50000), "server": ("test", 80),
             "subprotocols": [],
             "headers": [(b"host", b"test"),
                         *((k.encode(), v.encode()) for k, v in headers.items())]}
    await asyncio.wait_for(app(scope, receive, send), timeout=5)
    return sent


async def test_a_websocket_under_the_api_needs_a_session(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
        app = socket_app()
        for headers in ({}, device("made-up")):
            assert await open_socket(app, headers) == ["websocket.close 1008"]
        assert await open_socket(app, device(token)) == [
            "websocket.accept", "websocket.send", "websocket.close 1000"]


async def test_a_websocket_is_open_without_a_password(make_client):
    async with make_client():
        assert await open_socket(socket_app(), {}) == [
            "websocket.accept", "websocket.send", "websocket.close 1000"]


async def test_public_api_paths_stay_open(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        assert (await c.get("/api/health")).status_code == 200
        assert (await c.get("/api/gate")).json() == {"enabled": True, "authenticated": False}


async def test_api_docs_are_served_without_a_password(client):
    # Nothing to protect, and the schema is useful to anyone writing a client.
    assert (await client.get("/docs")).status_code == 200
    assert "/api/characters" in (await client.get("/openapi.json")).json()["paths"]


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
async def test_api_docs_are_not_served_with_a_password(make_client, path):
    """The schema maps the whole API, and these paths sit outside /api/, where
    the gate lets everything through. With a password they must not exist."""
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.get(path)
    assert r.status_code == 404
    assert "paths" not in r.text


async def test_api_docs_are_not_served_over_the_interface_either(make_client, tmp_path):
    ui = tmp_path / "ui"
    ui.mkdir()
    (ui / "index.html").write_text('<!doctype html><div id="root"></div>', encoding="utf-8")
    async with make_client(EVERMIND_GATE_PASSWORD=PW, EVERMIND_UI_DIR=str(ui)) as c:
        assert (await c.get("/")).status_code == 200
        for path in ("/docs", "/redoc", "/openapi.json"):
            r = await c.get(path)
            assert r.status_code == 404, path
            assert "swagger" not in r.text.lower() and '"paths"' not in r.text


async def test_login_cookie_attributes_over_http(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.post("/api/gate", json={"password": PW})
        assert r.status_code == 204
        cookie = r.headers["set-cookie"]
        assert cookie.startswith(f"{COOKIE}=")
        attrs = attributes(cookie)
        assert "httponly" in attrs
        assert "samesite=lax" in attrs
        assert "max-age=2592000" in attrs
        assert "path=/" in attrs
        assert "secure" not in attrs
        # The client's own cookie jar took it, over plain HTTP, and sends it back.
        assert (await c.get("/api/characters")).status_code == 200
        assert (await c.get("/api/gate")).json() == {"enabled": True, "authenticated": True}


async def test_login_cookie_is_secure_over_https(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.post("https://test/api/gate", json={"password": PW})
    assert r.status_code == 204
    assert "secure" in attributes(r.headers["set-cookie"])


async def test_tokens_are_random_and_never_stored(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        first = await sign_in(c)
        second = await sign_in(c)
        stored = {row["token_hash"] for row in await rows("SELECT token_hash FROM gate_sessions")}
    assert first != second
    for token in (first, second):
        assert len(token) >= 43
        assert PW not in token
        assert token not in stored
    assert stored == {gate.token_digest(first), gate.token_digest(second)}


async def test_password_is_stored_as_scrypt(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        await c.get("/api/gate")
        (row,) = await rows("SELECT password_hash FROM gate_state")
    assert row["password_hash"].startswith("scrypt$")
    assert PW not in row["password_hash"]


def test_password_hashes_are_salted_and_checked():
    first, second = gate.hash_password(PW), gate.hash_password(PW)
    assert first != second
    assert first.startswith("scrypt$16384$8$1$")
    assert gate.verify_password(PW, first) and gate.verify_password(PW, second)
    assert not gate.verify_password(PW + " ", first)
    assert not gate.verify_password("", first)
    # A string that is not valid UTF-8 can come out of JSON; it is just wrong.
    assert not gate.verify_password("\ud800", first)


@pytest.mark.parametrize("stored", [
    "",
    "plain",
    "scrypt$",
    "bcrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA",
    "scrypt$many$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA",
    "scrypt$16384$8$1$!!!!$AAAA",
    "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$",
    "scrypt$3$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA",
    "scrypt$1099511627776$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA",
    "scrypt$" + "9" * 5000 + "$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA",
    "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA$extra",
])
def test_unreadable_hashes_never_verify(stored):
    assert gate.verify_password(PW, stored) is False


@pytest.mark.parametrize("stored", [None, 16384, 1.5, ["scrypt"],
                                    b"scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA"])
def test_a_stored_digest_that_is_not_text_never_verifies(stored):
    # Whatever its type, an unreadable digest is a mismatch, never an error.
    assert gate.verify_password(PW, stored) is False


async def test_a_stored_digest_that_is_not_text_is_replaced(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
        conn = await connect()
        try:
            await conn.execute("UPDATE gate_state SET password_hash = ?", (bytes([0, 255]),))
            await conn.commit()
        finally:
            await conn.close()
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        # Unreadable counts as a different password: sessions end, the
        # password still opens.
        assert (await c.get("/api/characters", headers=device(token))).status_code == 401
        await sign_in(c)
        (row,) = await rows("SELECT password_hash FROM gate_state")
    assert row["password_hash"].startswith("scrypt$")


async def test_wrong_password_waits_and_refuses(make_client, pauses):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.post("/api/gate", json={"password": "nope"})
    assert r.status_code == 401
    assert r.json() == {"error": "Wrong password.", "kind": "wrong_password"}
    assert "set-cookie" not in r.headers
    assert len(pauses) == 1


async def test_odd_login_bodies_are_refused_not_errors(make_client, pauses):
    bodies = [b"", b"{}", b"not json", b'{"password": 3}', b'{"password": "\\ud800"}']
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        for body in bodies:
            r = await c.post("/api/gate", content=body,
                             headers={"content-type": "application/json"})
            assert r.status_code in (401, 422), (body, r.status_code)
            assert "set-cookie" not in r.headers


async def test_attempts_are_limited(make_client, pauses, clock):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        for _ in range(gate.MAX_FAILURES):
            assert (await c.post("/api/gate", json={"password": "nope"})).status_code == 401
        # The right password does not help while the address is blocked.
        r = await c.post("/api/gate", json={"password": PW})
        assert r.status_code == 429
        assert r.json() == {"error": "Too many attempts.", "kind": "rate_limited"}
        assert int(r.headers["retry-after"]) > 0
        assert "set-cookie" not in r.headers
        clock.advance(seconds=gate.FAILURE_WINDOW_S + 1)
        assert (await c.post("/api/gate", json={"password": PW})).status_code == 204


async def test_success_forgets_earlier_failures(make_client, pauses):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        for _ in range(gate.MAX_FAILURES - 1):
            await c.post("/api/gate", json={"password": "nope"})
        await sign_in(c)
        for _ in range(gate.MAX_FAILURES):
            assert (await c.post("/api/gate", json={"password": "nope"})).status_code == 401


async def test_parallel_attempts_cannot_pass_the_limit(make_client, monkeypatch):
    """Attempts sent all at once must not all be checked before any is counted."""

    async def pause() -> None:
        await asyncio.sleep(0)

    monkeypatch.setattr(gate, "failure_pause", pause)
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        replies = await asyncio.gather(
            *(c.post("/api/gate", json={"password": "nope"}) for _ in range(25))
        )
    codes = [r.status_code for r in replies]
    assert codes.count(401) == gate.MAX_FAILURES
    assert codes.count(429) == 25 - gate.MAX_FAILURES


async def test_passwords_are_checked_off_the_event_loop(make_client, monkeypatch, pauses):
    """scrypt takes tens of milliseconds on purpose. On the event loop, every
    attempt would hold up the replies being streamed meanwhile."""
    where: list[str] = []
    verify = gate.verify_password

    def spy(password: str, stored: object) -> bool:
        try:
            asyncio.get_running_loop()
            where.append("event loop")
        except RuntimeError:
            where.append("thread")
        return verify(password, stored)

    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        await c.get("/api/gate")
        monkeypatch.setattr(gate, "verify_password", spy)
        assert (await c.post("/api/gate", json={"password": "nope"})).status_code == 401
        assert (await c.post("/api/gate", json={"password": PW})).status_code == 204
    assert where == ["thread", "thread"]


def test_limiter_counts_each_address_on_its_own(clock):
    limiter = gate.AttemptLimiter()
    for _ in range(gate.MAX_FAILURES):
        assert limiter.retry_after("10.0.0.2") == 0
        limiter.record_failure("10.0.0.2")
    assert limiter.retry_after("10.0.0.2") == gate.FAILURE_WINDOW_S
    assert limiter.retry_after("10.0.0.3") == 0
    clock.advance(seconds=100)
    assert limiter.retry_after("10.0.0.2") == gate.FAILURE_WINDOW_S - 100
    limiter.reset("10.0.0.2")
    assert limiter.retry_after("10.0.0.2") == 0


async def test_logout_revokes_on_the_server(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
        r = await c.delete("/api/gate", headers=device(token))
        assert r.status_code == 204
        assert "max-age=0" in attributes(r.headers["set-cookie"])
        # The token itself is dead, not just forgotten by this browser.
        assert (await c.get("/api/characters", headers=device(token))).status_code == 401
        # Logging out without a session is not a mistake worth an error.
        assert (await c.delete("/api/gate")).status_code == 204
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        assert (await c.get("/api/characters", headers=device(token))).status_code == 401


async def test_logout_everywhere(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        phone = await sign_in(c)
        laptop = await sign_in(c)
        for token in (phone, laptop):
            assert (await c.get("/api/characters", headers=device(token))).status_code == 200
        assert (await c.delete("/api/gate/sessions", headers=device(phone))).status_code == 204
        for token in (phone, laptop):
            assert (await c.get("/api/characters", headers=device(token))).status_code == 401
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        assert (await c.get("/api/characters", headers=device(laptop))).status_code == 401


async def test_sessions_survive_a_restart(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        assert (await c.get("/api/characters", headers=device(token))).status_code == 200


async def test_changed_password_revokes_sessions(make_client, pauses):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
    async with make_client(EVERMIND_GATE_PASSWORD="other") as c:
        assert (await c.get("/api/characters", headers=device(token))).status_code == 401
        assert (await c.post("/api/gate", json={"password": PW})).status_code == 401
        assert (await c.post("/api/gate", json={"password": "other"})).status_code == 204


async def test_removed_password_clears_sessions(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
    async with make_client() as c:
        assert (await c.get("/api/characters")).status_code == 200
        assert await rows("SELECT * FROM gate_sessions") == []
        assert await rows("SELECT * FROM gate_state") == []
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        assert (await c.get("/api/characters", headers=device(token))).status_code == 401


async def test_session_expires_after_thirty_idle_days(make_client, clock):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
        clock.advance(days=31)
        assert (await c.get("/api/characters", headers=device(token))).status_code == 401
    # The next start forgets it altogether.
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        assert (await c.get("/api/characters", headers=device(token))).status_code == 401
        assert await rows("SELECT * FROM gate_sessions") == []


async def test_session_slides_when_used(make_client, clock):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
        clock.advance(days=2)
        r = await c.get("/api/characters", headers=device(token))
        assert r.status_code == 200
        cookie = r.headers["set-cookie"]
        assert cookie.startswith(f"{COOKIE}={token};")
        assert "max-age=2592000" in attributes(cookie)
        # Once a day is enough: the next request does not send it again.
        r = await c.get("/api/characters", headers=device(token))
        assert r.status_code == 200
        assert "set-cookie" not in r.headers
        clock.advance(days=29)
        assert (await c.get("/api/characters", headers=device(token))).status_code == 200
    # The new date was written down, not only kept in memory.
    clock.advance(days=29)
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        assert (await c.get("/api/characters", headers=device(token))).status_code == 200


async def test_sliding_never_undoes_a_cleared_cookie(make_client, clock):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
        clock.advance(days=2)
        r = await c.delete("/api/gate/sessions", headers=device(token))
    assert r.status_code == 204
    cookies = r.headers.get_list("set-cookie")
    assert len(cookies) == 1
    assert "max-age=0" in attributes(cookies[0])


async def test_non_ascii_password(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD="mot de passé ✨") as c:
        r = await c.post("/api/gate", json={"password": "mot de passé ✨"})
    assert r.status_code == 204


COMPOSED = unicodedata.normalize("NFC", "crème brûlée")
DECOMPOSED = unicodedata.normalize("NFD", COMPOSED)


def test_accents_compare_however_they_were_typed():
    # A phone keyboard and the editor the .env was written in need not encode
    # "è" the same way: one character, or "e" and a combining accent.
    assert COMPOSED != DECOMPOSED
    assert gate.verify_password(DECOMPOSED, gate.hash_password(COMPOSED))
    assert gate.verify_password(COMPOSED, gate.hash_password(DECOMPOSED))


@pytest.mark.parametrize(("configured", "typed"), [(COMPOSED, DECOMPOSED),
                                                   (DECOMPOSED, COMPOSED)])
async def test_an_accent_typed_another_way_opens(make_client, configured, typed):
    async with make_client(EVERMIND_GATE_PASSWORD=configured) as c:
        assert (await c.post("/api/gate", json={"password": typed})).status_code == 204


async def test_the_same_password_written_another_way_keeps_sessions(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=COMPOSED) as c:
        token = await sign_in(c, COMPOSED)
    async with make_client(EVERMIND_GATE_PASSWORD=DECOMPOSED) as c:
        assert (await c.get("/api/characters", headers=device(token))).status_code == 200


async def test_garbage_cookie_is_locked_not_an_error(make_client):
    values = [b"%%%", b"", b'"quoted"', b"x" * 5000, "é".encode()]
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        for value in values:
            header = {"cookie": COOKIE.encode() + b"=" + value}
            r = await c.get("/api/characters", headers=header)
            assert r.status_code == 401, value
            r = await c.get("/api/gate", headers=header)
            assert r.json() == {"enabled": True, "authenticated": False}
            assert (await c.delete("/api/gate", headers=header)).status_code == 204


async def test_turn_stream_passes_through(make_client):
    path = "/api/conversations/nope/turn/stream"
    async with make_client() as c:
        open_reply = await c.get(path)
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
        gated_reply = await c.get(path, headers=device(token))
    assert gated_reply.status_code == open_reply.status_code
    assert gated_reply.headers["content-type"] == open_reply.headers["content-type"]
    assert gated_reply.text == open_reply.text


async def test_streams_are_never_held_back():
    """Each message of a response goes out as soon as the app sends it, the
    reissued cookie included; a reply still being written is never buffered."""
    second_part = asyncio.Event()

    async def streaming_app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"one", "more_body": True})
        await asyncio.wait_for(second_part.wait(), timeout=2)
        await send({"type": "http.response.body", "body": b"two", "more_body": False})

    class Store:
        enabled = True

        async def ensure_loaded(self) -> None:
            pass

        def check(self, token: str | None) -> bool:
            return token == "t"

        async def touch(self, token: str) -> bool:
            return True

    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)
        if message.get("body") == b"one":
            second_part.set()

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    scope = {"type": "http", "method": "GET", "path": "/api/conversations/x/turn/stream",
             "scheme": "http", "headers": [(b"cookie", f"{COOKIE}=t".encode())]}
    await gate.GateMiddleware(streaming_app, store=Store())(scope, receive, send)

    assert [m.get("body") for m in sent] == [None, b"one", b"two"]
    cookies = [v for k, v in sent[0]["headers"] if k == b"set-cookie"]
    assert len(cookies) == 1 and cookies[0].startswith(f"{COOKIE}=t;".encode())
