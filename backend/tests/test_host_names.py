"""Without a password, the API answers only to an address or localhost.

A page on attacker.example can have its name made to point at 127.0.0.1 once
it is loaded (DNS rebinding). The browser then sends that page's requests to
Evermind as same-origin ones, so the cross-origin rule lets them through. Only
the name in Host gives it away. With a password the name does not matter: the
session cookie belongs to the name the device signed in on, and a rebound page
has none.
"""

import pytest

PW = "s3cret"
REFUSED = {"error": "Unknown host name. Open Evermind by its address, or set a password.",
           "kind": "unknown_host"}
CHARACTER = {"name": "Serana", "greeting": "Hello."}
# What a rebound page's requests look like: same-origin in every header.
REBOUND = {"host": "attacker.example:3000", "origin": "http://attacker.example:3000"}


@pytest.mark.parametrize(("method", "path"), [
    ("GET", "/api/characters"), ("POST", "/api/characters"), ("GET", "/api/gate"),
    ("GET", "/api/health"),
])
async def test_a_rebound_name_is_refused_without_a_password(client, method, path):
    body = CHARACTER if method == "POST" else None
    r = await client.request(method, path, json=body, headers=REBOUND)
    assert (r.status_code, r.json()) == (403, REFUSED)
    assert (await client.get("/api/characters")).json() == []


async def test_a_rebound_name_meets_the_password_instead(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.get("/api/gate", headers=REBOUND)
        assert r.json() == {"enabled": True, "authenticated": False}
        assert (await c.get("/api/characters", headers=REBOUND)).status_code == 401
        # A proxy may serve Evermind under any name once there is a password.
        r = await c.post("/api/gate", json={"password": PW}, headers={"host": "evermind.example"})
        assert r.status_code == 204


@pytest.mark.parametrize("host", [
    "localhost", "localhost:3000", "LocalHost:3000", "127.0.0.1", "192.168.1.42:3000",
    "[::1]:3000", "[fe80::1ff:fe23:4567:890a]:3000",
])
async def test_addresses_and_localhost_are_answered(client, host):
    assert (await client.get("/api/characters", headers={"host": host})).status_code == 200


@pytest.mark.parametrize("host", [
    # Names, this computer's own included: a website can lend itself any of them.
    "study-pc", "nas.local", "evermind.localhost", "localhost.example", "127.0.0.1.evil.com",
    # These are not hosts at all: refused, never an error.
    "localhost:3000@evil.com", "::1", "[::1", "[127.0.0.1]", "", " ",
])
async def test_anything_else_is_refused(client, host):
    r = await client.get("/api/characters", headers={"host": host})
    assert (r.status_code, r.json()) == (403, REFUSED)


async def test_the_interface_itself_is_not_checked(make_client, tmp_path):
    # Its files hold no data; what they ask the API for is checked there.
    ui = tmp_path / "ui"
    ui.mkdir()
    (ui / "index.html").write_text('<!doctype html><div id="root"></div>', encoding="utf-8")
    async with make_client(EVERMIND_UI_DIR=str(ui)) as c:
        assert (await c.get("/", headers=REBOUND)).status_code == 200
        assert (await c.get("/api/characters", headers=REBOUND)).status_code == 403
