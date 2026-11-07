"""The access password, kept by the backend.

One session per device, of which the database only holds an HMAC keyed by the
password; wrong attempts limited per address; a logout that the server
honours. Many people reach Evermind from a phone over plain HTTP on a LAN
address, so the cookie has to work without the Secure flag there.
"""

import asyncio
import types
import unicodedata

import pytest

from app import gate
from app.db import connect

PW = "s3cret"
COOKIE = gate.SESSION_COOKIE
LOCKED = {"error": "Locked.", "kind": "locked"}
LONGEST = f"max-age={400 * 86400}"


async def sign_in(c, password: str = PW) -> str:
    """Signs in as a new device and returns its token, leaving the client's jar
    empty so that every later request says which device it comes from."""
    r = await c.post("/api/gate", json={"password": password})
    assert r.status_code == 204, r.text
    c.cookies.clear()
    return r.cookies[COOKIE]


def device(token: str) -> dict:
    return {"cookie": f"{COOKIE}={token}"}


def attributes(set_cookie: str) -> list[str]:
    return [part.strip().lower() for part in set_cookie.split(";")[1:]]


async def test_off_without_a_password(client):
    assert (await client.get("/api/characters")).status_code == 200
    assert (await client.get("/api/gate")).json() == {"enabled": False, "authenticated": False}
    r = await client.post("/api/gate", json={"password": "anything"})
    assert r.status_code == 204 and "set-cookie" not in r.headers


@pytest.mark.parametrize(("method", "path"), [
    ("GET", "/api/characters"), ("GET", "/api/media/x.png"),
    ("GET", "/api/conversations/x/turn/stream"), ("DELETE", "/api/gate/sessions"),
    # Only the two public paths themselves are open, not what sits next to them.
    ("GET", "/api/gate/"), ("GET", "/api/gatex"), ("GET", "/api/health/"), ("GET", "/api/healthz"),
])
async def test_locked_without_a_session(make_client, method, path):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.request(method, path)
        assert (r.status_code, r.json()) == (401, LOCKED)
        assert (await c.get("/api/health")).status_code == 200
        assert (await c.get("/api/gate")).json() == {"enabled": True, "authenticated": False}


@pytest.mark.parametrize("password", ["", PW])
@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
async def test_api_docs_are_not_served(make_client, path, password):
    """The schema maps the whole API, and these paths sit outside /api/, where
    the gate lets everything through."""
    async with make_client(EVERMIND_GATE_PASSWORD=password) as c:
        r = await c.get(path)
    assert r.status_code == 404
    assert "paths" not in r.text


async def test_a_device_signs_in_over_plain_http_and_stays(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.post("/api/gate", json={"password": PW})
        attrs = attributes(r.headers["set-cookie"])
        assert {"httponly", "samesite=lax", "path=/", LONGEST} <= set(attrs)
        assert "secure" not in attrs
        # The client's own jar took it, over plain HTTP, and sends it back.
        assert (await c.get("/api/characters")).status_code == 200
        r = await c.post("https://localhost/api/gate", json={"password": PW})
        assert "secure" in attributes(r.headers["set-cookie"])


async def test_opening_the_app_renews_the_cookie(make_client):
    # The interface asks this on every opening: a device in use never meets the password again.
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
        r = await c.get("/api/gate", headers=device(token))
        assert r.json() == {"enabled": True, "authenticated": True}
        assert r.headers["set-cookie"].startswith(f"{COOKIE}={token};")
        assert LONGEST in attributes(r.headers["set-cookie"])
        assert "set-cookie" not in (await c.get("/api/gate", headers=device("made-up"))).headers


async def test_the_database_holds_no_token(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        tokens = {await sign_in(c), await sign_in(c)}
        conn = await connect()
        try:
            stored = {row[0] for row in await conn.execute_fetchall("SELECT * FROM gate_sessions")}
        finally:
            await conn.close()
    assert len(tokens) == len(stored) == 2
    assert all(len(token) >= 43 for token in tokens)
    assert not tokens & stored


async def test_sessions_outlive_a_restart_but_not_a_new_password(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        assert (await c.get("/api/characters", headers=device(token))).status_code == 200
    async with make_client(EVERMIND_GATE_PASSWORD="other") as c:
        assert (await c.get("/api/characters", headers=device(token))).status_code == 401
        assert (await c.post("/api/gate", json={"password": PW})).status_code == 401
        await sign_in(c, "other")


COMPOSED = unicodedata.normalize("NFC", "crème brûlée ✨")
DECOMPOSED = unicodedata.normalize("NFD", COMPOSED)


@pytest.mark.parametrize(("configured", "typed"), [(COMPOSED, DECOMPOSED), (DECOMPOSED, COMPOSED)])
async def test_an_accent_typed_another_way_is_the_same_password(make_client, configured, typed):
    # A phone keyboard and the editor of .env need not write "è" the same way.
    async with make_client(EVERMIND_GATE_PASSWORD=configured) as c:
        token = await sign_in(c, typed)
    async with make_client(EVERMIND_GATE_PASSWORD=typed) as c:
        assert (await c.get("/api/characters", headers=device(token))).status_code == 200


@pytest.mark.parametrize(("body", "code"), [
    (b'{"password": "nope"}', 401), (b'{"password": ""}', 401),
    # Valid JSON, and not valid UTF-8: a wrong password, not an error.
    (b'{"password": "\\ud800"}', 401),
    (b"{}", 422), (b"not json", 422), (b'{"password": 3}', 422),
])
async def test_a_wrong_password_is_refused(make_client, body, code):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.post("/api/gate", content=body, headers={"content-type": "application/json"})
    assert r.status_code == code
    assert "set-cookie" not in r.headers
    if code == 401:
        assert r.json() == {"error": "Wrong password.", "kind": "wrong_password"}


async def test_attempts_are_limited_for_each_address(make_client, monkeypatch):
    clock = types.SimpleNamespace(monotonic=lambda: 1000.0)
    monkeypatch.setattr(gate, "time", clock)
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        for _ in range(gate.MAX_FAILURES):
            assert (await c.post("/api/gate", json={"password": "nope"})).status_code == 401
        # The right password does not help while the address is blocked.
        r = await c.post("/api/gate", json={"password": PW})
        assert (r.status_code, r.json()) == (429, {"error": "Too many attempts.",
                                                   "kind": "rate_limited"})
        assert r.headers["retry-after"] == str(gate.FAILURE_WINDOW_S)
        assert "set-cookie" not in r.headers
        assert gate.retry_after("10.0.0.2") == 0
        # Once the window has run out, the next one counts afresh and limits as the first did.
        clock.monotonic = lambda: 1000.0 + gate.FAILURE_WINDOW_S
        for _ in range(gate.MAX_FAILURES):
            assert (await c.post("/api/gate", json={"password": "nope"})).status_code == 401
        assert (await c.post("/api/gate", json={"password": PW})).status_code == 429
        clock.monotonic = lambda: 1000.0 + 2 * gate.FAILURE_WINDOW_S
        await sign_in(c)


async def test_signing_in_forgets_the_wrong_attempts(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        for _ in range(gate.MAX_FAILURES - 1):
            await c.post("/api/gate", json={"password": "nope"})
        await sign_in(c)
        for _ in range(gate.MAX_FAILURES):
            assert (await c.post("/api/gate", json={"password": "nope"})).status_code == 401


async def test_attempts_sent_at_once_cannot_pass_the_limit(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        replies = await asyncio.gather(
            *(c.post("/api/gate", json={"password": "nope"}) for _ in range(25)))
    codes = [r.status_code for r in replies]
    assert (codes.count(401), codes.count(429)) == (gate.MAX_FAILURES, 25 - gate.MAX_FAILURES)


async def test_signing_out_ends_the_session_on_the_server(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        token = await sign_in(c)
        r = await c.delete("/api/gate", headers=device(token))
        assert r.status_code == 204
        assert "max-age=0" in attributes(r.headers["set-cookie"])
        # The token itself is dead, not just forgotten by this browser.
        assert (await c.get("/api/characters", headers=device(token))).status_code == 401
        assert (await c.delete("/api/gate")).status_code == 204


async def test_signing_out_every_device(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        phone, laptop = await sign_in(c), await sign_in(c)
        r = await c.delete("/api/gate/sessions", headers=device(phone))
        assert r.status_code == 204
        assert "max-age=0" in attributes(r.headers["set-cookie"])
        for token in (phone, laptop):
            assert (await c.get("/api/characters", headers=device(token))).status_code == 401


async def test_a_garbage_cookie_is_locked_not_an_error(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        for value in (b"%%%", b"", b'"quoted"', b"x" * 5000, "é".encode()):
            header = {"cookie": COOKIE.encode() + b"=" + value}
            assert (await c.get("/api/characters", headers=header)).status_code == 401
            r = await c.get("/api/gate", headers=header)
            assert r.json() == {"enabled": True, "authenticated": False}
            assert (await c.delete("/api/gate", headers=header)).status_code == 204


async def test_a_stream_is_never_held_back(make_client):
    """Each message of a response goes out as soon as the app sends it."""
    second_part = asyncio.Event()
    sent: list[dict] = []

    async def streaming_app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"one", "more_body": True})
        await asyncio.wait_for(second_part.wait(), timeout=2)
        await send({"type": "http.response.body", "body": b"two"})

    async def send(message: dict) -> None:
        sent.append(message)
        if message.get("body") == b"one":
            second_part.set()

    async with make_client(EVERMIND_GATE_PASSWORD=PW):
        token = await gate.open_session()
        scope = {"type": "http", "method": "GET", "path": "/api/conversations/x/turn/stream",
                 "headers": [(b"cookie", f"{COOKIE}={token}".encode())]}
        await gate.GateMiddleware(streaming_app)(scope, None, send)
    assert [m.get("body") for m in sent] == [None, b"one", b"two"]
