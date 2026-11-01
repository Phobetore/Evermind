"""Without a password, the API answers only to host names it knows.

A page on attacker.example can have its name made to point at 127.0.0.1 once
it is loaded (DNS rebinding). The browser then sends that page's requests to
Evermind as same-origin ones, with Origin equal to Host and Sec-Fetch-Site
"same-origin", so the cross-origin rule lets them through. Only the name in
Host gives it away. With a password the name does not matter: the session
cookie belongs to the name the device signed in on, and a rebound page has
none.
"""

import pytest

from app import gate

from .test_gate import open_socket, socket_app

PW = "s3cret"
REFUSED = {"error": "Unknown host name. Add it to EVERMIND_ALLOWED_HOSTS or set a password.",
           "kind": "unknown_host"}
NO_HOST = {"error": "The request has no Host header.", "kind": "unknown_host"}
CHARACTER = {"name": "Serana", "greeting": "Hello."}
# What a rebound page's requests look like: same-origin in every header.
REBOUND = {"host": "attacker.example:3000", "origin": "http://attacker.example:3000",
           "sec-fetch-site": "same-origin"}


async def names(client) -> list[str]:
    return [c["name"] for c in (await client.get("/api/characters")).json()]


@pytest.fixture()
def machine(monkeypatch):
    """This computer's name, as the system would give it."""
    monkeypatch.setattr(gate, "machine_name", lambda: "Study-PC")


@pytest.mark.parametrize("method", ["GET", "POST"])
async def test_a_rebound_name_is_refused_without_a_password(client, method):
    r = await client.request(method, "/api/characters", json=CHARACTER, headers=REBOUND)
    assert r.status_code == 403
    assert r.json() == REFUSED
    assert await names(client) == []


@pytest.mark.parametrize("path", ["/api/gate", "/api/health"])
async def test_the_public_paths_are_refused_too(client, path):
    r = await client.get(path, headers=REBOUND)
    assert r.status_code == 403
    assert r.json() == REFUSED


async def test_a_websocket_from_a_rebound_name_is_refused(make_client):
    async with make_client():
        assert await open_socket(socket_app(), REBOUND) == ["websocket.close 1008"]
    async with make_client(EVERMIND_GATE_PASSWORD=PW):
        # With a password the name is not checked; the missing session is.
        assert await open_socket(socket_app(), REBOUND) == ["websocket.close 1008"]


async def test_a_rebound_name_meets_the_password_instead(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.get("/api/gate", headers=REBOUND)
        assert r.json() == {"enabled": True, "authenticated": False}
        r = await c.get("/api/characters", headers=REBOUND)
        assert r.status_code == 401
        assert r.json()["kind"] == "locked"
        # A proxy may serve Evermind under any name once there is a password.
        r = await c.post("/api/gate", json={"password": PW}, headers={"host": "evermind.example"})
        assert r.status_code == 204


@pytest.mark.parametrize("host", [
    "localhost", "localhost:3000", "LocalHost:3000", "localhost.", "evermind.localhost:3000",
    "127.0.0.1", "127.0.0.1:3000", "192.168.1.42:3000", "10.0.0.5",
    "[::1]", "[::1]:3000", "[fe80::1ff:fe23:4567:890a]:3000",
])
async def test_addresses_and_localhost_are_answered(client, host):
    assert (await client.get("/api/characters", headers={"host": host})).status_code == 200


@pytest.mark.parametrize("host", ["study-pc", "Study-PC:3000", "study-pc.local",
                                  "STUDY-PC.LOCAL:3000"])
async def test_this_computers_name_is_answered(client, machine, host):
    assert (await client.get("/api/characters", headers={"host": host})).status_code == 200


@pytest.mark.parametrize("host", ["study-pc.example", "other-pc.local", "localhost.example",
                                  "study-pc.local.example"])
async def test_names_that_only_look_known_are_refused(client, machine, host):
    r = await client.get("/api/characters", headers={"host": host})
    assert r.status_code == 403
    assert r.json() == REFUSED


@pytest.fixture()
def machine_with_domain(monkeypatch):
    """A computer whose system name carries its domain, as a NAS or a server on
    a home network often does."""
    monkeypatch.setattr(gate, "machine_name", lambda: "NAS.home.lan")


@pytest.mark.parametrize("host", ["nas.home.lan", "NAS.Home.LAN:3000", "nas", "nas:3000",
                                  "nas.local", "NAS.LOCAL:3000"])
async def test_a_name_with_a_domain_is_answered_by_its_first_label_too(
        client, machine_with_domain, host):
    assert (await client.get("/api/characters", headers={"host": host})).status_code == 200


@pytest.mark.parametrize("host", ["nas.evil.com", "nas.home.lan.evil.com", "nas.lan",
                                  "home.lan", "home", "lan.local", "nas.local.evil.com"])
async def test_only_the_first_label_of_a_name_with_a_domain_is_borrowed(
        client, machine_with_domain, host):
    r = await client.get("/api/characters", headers={"host": host})
    assert r.status_code == 403
    assert r.json() == REFUSED


async def test_a_system_without_a_name_lends_nothing(client, monkeypatch):
    # An empty name must not turn ".local" into this computer's own.
    monkeypatch.setattr(gate, "machine_name", lambda: "")
    r = await client.get("/api/characters", headers={"host": ".local"})
    assert r.status_code == 403
    assert r.json() == REFUSED


@pytest.mark.parametrize("host", [
    # What a name looks like with something else behind it: a browser never
    # sends these, and a parser that stops at the first colon would take the
    # first one for localhost.
    "localhost:3000@evil.com", "localhost:evil.com", "localhost@evil.com",
    "evil.com@localhost", "localhost/evil", "localhost#evil", "localhost?x=1",
    "local host", "localhost:3000 evil.com", "localhost\\evil",
    # A port is digits and nothing else, and there is at most one.
    "localhost:", "localhost:3000:4000", "localhost:30a0", "127.0.0.1:-1",
    # An IPv6 address needs its brackets, and the brackets need an IPv6 address.
    "::1", "::1:3000", "fe80::1", "[::1", "::1]", "[::1]x", "[::1]:", "[::1]:abc",
    "[localhost]", "[127.0.0.1]", "[]", "[::1]:3000:4000", "[[::1]]",
    # Nothing at all, or nothing but space.
    "", " ", ":3000",
])
async def test_a_host_header_that_is_not_a_host_is_refused(client, host):
    r = await client.get("/api/characters", headers={"host": host})
    assert r.status_code == 403
    assert r.json() == REFUSED


async def test_a_request_without_a_host_header_is_refused_with_its_own_message(client):
    # HTTP/1.0 clients may leave it out, and a browser never does.
    request = client.build_request("GET", "/api/characters")
    del request.headers["host"]
    r = await client.send(request)
    assert r.status_code == 403
    assert r.json() == NO_HOST


async def test_a_request_without_a_host_header_meets_the_password_instead(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        request = c.build_request("GET", "/api/characters")
        del request.headers["host"]
        r = await c.send(request)
        assert r.status_code == 401
        assert r.json()["kind"] == "locked"


async def test_allowed_names_are_answered(make_client):
    async with make_client(EVERMIND_ALLOWED_HOSTS=" evermind.lan , Studio.Home:8080,, ") as c:
        for host in ("evermind.lan", "EVERMIND.LAN:3000", "studio.home", "studio.home:3000"):
            assert (await c.get("/api/characters", headers={"host": host})).status_code == 200
        assert (await c.get("/api/characters", headers=REBOUND)).status_code == 403


async def test_a_listed_name_that_is_not_a_host_allows_nothing(make_client):
    async with make_client(EVERMIND_ALLOWED_HOSTS="evil.com@x, [oops, a b, evermind.lan") as c:
        for host in ("evil.com", "x", "oops", "a b", "[oops"):
            assert (await c.get("/api/characters", headers={"host": host})).status_code == 403
        assert (await c.get("/api/characters", headers={"host": "evermind.lan"})).status_code == 200


async def test_the_interface_itself_is_not_checked(make_client, tmp_path):
    # Its files hold no data; what they ask the API for is checked there.
    ui = tmp_path / "ui"
    ui.mkdir()
    (ui / "index.html").write_text('<!doctype html><div id="root"></div>', encoding="utf-8")
    async with make_client(EVERMIND_UI_DIR=str(ui)) as c:
        assert (await c.get("/", headers=REBOUND)).status_code == 200
        assert (await c.get("/api/characters", headers=REBOUND)).status_code == 403
