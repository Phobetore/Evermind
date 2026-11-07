"""The sign-in, the one call anyone can make while a password is set.

A client gets ten wrong passwords per 15 minutes for its address. A header
naming another address counts only from a proxy the owner has named, or each
guess would claim an address of its own. And what anyone sends costs little:
a long body is refused unread, and what does not validate is not echoed back.
"""

import socket
from contextlib import asynccontextmanager

import httpx
import pytest
import uvicorn

from app import __main__ as launch
from app import gate
from app.main import create_app

PW = "s3cret"
COOKIE = gate.SESSION_COOKIE


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@asynccontextmanager
async def as_served(monkeypatch, tmp_path, **env):
    """The application as ``python -m app`` hands it to uvicorn, behind uvicorn's own
    reading of proxy headers, and a client on 127.0.0.1, where a proxy on this computer
    comes from."""
    ui = tmp_path / "ui"
    ui.mkdir(exist_ok=True)
    (ui / "index.html").write_text("<!doctype html>", encoding="utf-8")
    monkeypatch.delenv("FORWARDED_ALLOW_IPS", raising=False)
    for name, value in {"EVERMIND_UI_DIR": str(ui), "PORT": str(free_port()), **env}.items():
        monkeypatch.setenv(name, value)
    handed = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: handed.append(kwargs))
    assert launch.main(["--no-env-file"]) == 0
    config = uvicorn.Config(create_app(), log_config=None, **handed[0])
    config.load()
    transport = httpx.ASGITransport(app=config.loaded_app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as c:
        yield c


def sign_in(c, *, sent_for: str | None = None, over_https: bool = False):
    headers = {"x-forwarded-for": sent_for} if sent_for else {}
    if over_https:
        headers["x-forwarded-proto"] = "https"
    return c.post("/api/gate", json={"password": PW}, headers=headers)


async def wrong(c, sent_for: str) -> int:
    r = await c.post("/api/gate", json={"password": "nope"}, headers={"x-forwarded-for": sent_for})
    return r.status_code


def secure(response: httpx.Response) -> bool:
    return "secure" in response.headers["set-cookie"].lower().split("; ")


async def test_a_client_names_neither_its_address_nor_its_scheme(make_client, monkeypatch,
                                                                 tmp_path):
    async with make_client(EVERMIND_GATE_PASSWORD=PW), as_served(monkeypatch, tmp_path) as c:
        r = await sign_in(c, over_https=True)
        token = r.cookies[COOKIE]
        assert not secure(r)
        renewed = await c.get("/api/gate", headers={"cookie": f"{COOKIE}={token}",
                                                     "x-forwarded-proto": "https"})
        assert not secure(renewed)
        assert [await wrong(c, f"198.51.100.{n}") for n in range(gate.MAX_FAILURES)] == [401] * 10
        assert (await sign_in(c, sent_for="198.51.100.99")).status_code == 429


async def test_a_proxy_named_by_the_owner_says_who_the_client_is(make_client, monkeypatch,
                                                                 tmp_path):
    async with make_client(EVERMIND_GATE_PASSWORD=PW), as_served(
            monkeypatch, tmp_path, FORWARDED_ALLOW_IPS="127.0.0.1") as c:
        assert [await wrong(c, "198.51.100.1") for _ in range(gate.MAX_FAILURES)] == [401] * 10
        # Another device behind the proxy has a count of its own, and came over https.
        r = await sign_in(c, sent_for="198.51.100.2", over_https=True)
        assert r.status_code == 204 and secure(r)
        renewed = await c.get("/api/gate", headers={"cookie": f"{COOKIE}={r.cookies[COOKIE]}",
                                                     "x-forwarded-proto": "https"})
        assert secure(renewed)
        assert (await sign_in(c, sent_for="198.51.100.1")).status_code == 429


@pytest.mark.parametrize("headers", [
    [(b"content-length", b"209715200")],
    [(b"transfer-encoding", b"chunked")],
    # What a chunked body says of its length does not bound it.
    [(b"content-length", b"22"), (b"transfer-encoding", b"chunked")],
])
async def test_a_long_sign_in_or_one_of_unknown_length_is_refused_unread(make_client, headers):
    # 200 MiB of password once took 600 MB of memory to be told it was wrong.
    async def past_the_gate(*_):
        raise AssertionError("the body was read, or the request let through")

    sent = []

    async def send(message):
        sent.append(message)

    async with make_client(EVERMIND_GATE_PASSWORD=PW):
        scope = {"type": "http", "method": "POST", "path": "/api/gate", "headers": headers}
        await gate.GateMiddleware(past_the_gate)(scope, past_the_gate, send)
    assert sent[0]["status"] == 413


@pytest.mark.parametrize(("size", "code"), [(4096, 401), (4097, 413)])
async def test_a_sign_in_is_4096_bytes_at_most(make_client, size, code):
    body = b'{"password": "' + b"x" * (size - 16) + b'"}'
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.post("/api/gate", content=body, headers={"content-type": "application/json"})
    assert len(body) == size and r.status_code == code


async def test_a_sign_in_that_does_not_say_its_length_is_refused(make_client):
    # A browser always says it. The right password is not let through either.
    async def chunks():
        yield b'{"password": "s3cret"}'

    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.post("/api/gate", content=chunks(),
                         headers={"content-type": "application/json"})
    assert r.status_code == 413


@pytest.mark.parametrize("password", [b"[" * 2000 + b"]" * 2000, b'{"typed": "hunter2"}', b"12345"])
async def test_a_password_that_is_not_text_is_refused_and_not_echoed(make_client, password):
    # Nested two thousand deep, it once made a 500 of the answer it was echoed back in.
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.post("/api/gate", content=b'{"password": ' + password + b"}",
                         headers={"content-type": "application/json"})
    assert (r.status_code, r.json()) == (422, {"detail": [{
        "type": "string_type", "loc": ["body", "password"],
        "msg": "Input should be a valid string"}]})


async def test_nothing_that_does_not_validate_is_echoed_back(client):
    r = await client.post("/api/characters", json={"name": {"typed": "hunter2"}})
    assert r.status_code == 422 and "hunter2" not in r.text
