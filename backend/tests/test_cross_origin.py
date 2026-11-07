"""Writes to the API from a page of another origin are refused, password or not.

A browser lets any page send a form-like request to any address, with the
session cookie too when the page is on the same site, such as another port of
the same machine; without a password there is no cookie to need. The browser
names that page in Origin, which the API compares with Host.

The client used here sends no browser headers of its own. Its address is
http://localhost.
"""

import pytest

PW = "s3cret"
REFUSED = {"error": "Cross-origin request refused.", "kind": "cross_origin"}
CHARACTER = {"name": "Serana", "greeting": "Hello."}


async def names(client) -> list[str]:
    return [c["name"] for c in (await client.get("/api/characters")).json()]


@pytest.mark.parametrize("headers", [
    {"origin": "http://localhost"},
    # A phone on the network: over plain http, Origin is all a browser says.
    {"host": "192.168.1.42:3000", "origin": "http://192.168.1.42:3000"},
    # Vite's proxy keeps the browser's Host (changeOrigin is off in vite.config.ts).
    {"host": "localhost:3000", "origin": "http://localhost:3000"},
    # A proxy that ends https and passes Host on reaches the API over http.
    {"host": "192.168.1.42", "origin": "https://192.168.1.42"},
    # curl, a script, Playwright's request fixture.
    {},
])
async def test_writes_from_this_origin_are_allowed(client, headers):
    r = await client.post("/api/characters", json=CHARACTER, headers=headers)
    assert r.status_code == 201, r.text


@pytest.mark.parametrize("origin", [
    "http://evil.example", "http://localhost:8080", "http://localhost.evil.example", "null",
    "http://[oops",
])
async def test_another_origin_is_refused(client, origin):
    r = await client.post("/api/characters", json=CHARACTER, headers={"origin": origin})
    assert (r.status_code, r.json()) == (403, REFUSED)
    assert await names(client) == []


@pytest.mark.parametrize("method", ["PUT", "PATCH", "DELETE"])
async def test_every_write_method_is_checked(client, method):
    created = (await client.post("/api/characters", json=CHARACTER)).json()
    r = await client.request(method, f"/api/characters/{created['id']}",
                             json={"name": "Changed"}, headers={"origin": "http://evil.example"})
    assert r.status_code == 403
    assert await names(client) == ["Serana"]


async def test_reads_from_another_origin_are_allowed(client):
    # The browser keeps the answer from the page that asked; nothing changed.
    r = await client.get("/api/characters", headers={"origin": "http://evil.example"})
    assert r.status_code == 200


async def test_pages_outside_the_api_are_not_judged(client):
    r = await client.post("/somewhere", headers={"origin": "http://evil.example"})
    assert (r.status_code, r.json()) == (404, {"detail": "Not Found"})


async def test_the_login_is_checked_too(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.post("/api/gate", json={"password": PW},
                         headers={"origin": "http://evil.example"})
        assert (r.status_code, r.json()) == (403, REFUSED)
        assert "set-cookie" not in r.headers
