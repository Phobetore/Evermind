"""Writes to the API from a page of another origin are refused.

A browser lets any page send a form-like request to any address: a POST with
no body, a multipart upload. With the session cookie too when the page is on
the same site, such as another port of the same machine. Without a password
there is no cookie to need, so a website could write to an Evermind listening
on localhost. The browser says where such a request comes from, and the API
refuses the ones from elsewhere, password or not.

The client used here sends no browser headers of its own: each test adds the
ones a browser would. Its address is http://test.
"""

import json

import pytest

PW = "s3cret"
REFUSED = {"error": "Cross-origin request refused.", "kind": "cross_origin"}
CHARACTER = {"name": "Serana", "greeting": "Hello."}


async def characters(client) -> list[str]:
    return [c["name"] for c in (await client.get("/api/characters")).json()]


@pytest.mark.parametrize("site", ["same-origin", "none"])
async def test_fetch_metadata_from_this_origin_is_allowed(client, site):
    r = await client.post("/api/characters", json=CHARACTER, headers={"sec-fetch-site": site})
    assert r.status_code == 201, r.text


@pytest.mark.parametrize("site", ["same-site", "cross-site", "something-new"])
async def test_fetch_metadata_from_elsewhere_is_refused(client, site):
    r = await client.post("/api/characters", json=CHARACTER, headers={"sec-fetch-site": site})
    assert r.status_code == 403
    assert r.json() == REFUSED
    assert await characters(client) == []


async def test_fetch_metadata_wins_over_origin(client):
    # Behind an https proxy that rewrites Host, Origin names the proxy's
    # address and Host the backend's, but the browser's own verdict is there.
    proxied = {"sec-fetch-site": "same-origin", "origin": "https://evermind.example"}
    assert (await client.post("/api/characters", json=CHARACTER, headers=proxied)).status_code == 201
    forged = {"sec-fetch-site": "cross-site", "origin": "http://test"}
    assert (await client.post("/api/characters", json=CHARACTER, headers=forged)).status_code == 403


async def test_same_origin_json_post_is_allowed(client):
    r = await client.post("/api/characters", json=CHARACTER, headers={"origin": "http://test"})
    assert r.status_code == 201, r.text


async def test_a_phone_on_the_network_is_allowed(client):
    # Plain http to a LAN address: no Fetch Metadata, only Origin.
    phone = {"host": "192.168.1.42:3000", "origin": "http://192.168.1.42:3000"}
    assert (await client.post("/api/characters", json=CHARACTER, headers=phone)).status_code == 201


async def test_the_development_proxy_is_allowed(client):
    # Vite relays /api without changing Host, so both name its own address.
    dev = {"host": "localhost:3000", "origin": "http://localhost:3000"}
    assert (await client.post("/api/characters", json=CHARACTER, headers=dev)).status_code == 201


@pytest.mark.parametrize("origin", [
    "http://evil.example",
    "http://test:8080",
    "https://test",
    "http://test.evil.example",
    "null",
])
async def test_another_origin_is_refused(client, origin):
    r = await client.post("/api/characters", json=CHARACTER, headers={"origin": origin})
    assert r.status_code == 403
    assert r.json() == REFUSED
    assert await characters(client) == []


async def test_a_multipart_upload_from_another_origin_is_refused(client):
    card = {"spec": "chara_card_v2", "spec_version": "2.0",
            "data": {"name": "Imported", "first_mes": "hi"}}
    files = {"file": ("card.json", json.dumps(card).encode(), "application/json")}
    r = await client.post("/api/characters/import", files=files,
                          headers={"origin": "http://192.168.1.50:8080"})
    assert r.status_code == 403
    assert r.json() == REFUSED
    assert await characters(client) == []


@pytest.mark.parametrize("method", ["PUT", "PATCH", "DELETE"])
async def test_every_write_method_is_checked(client, method):
    created = (await client.post("/api/characters", json=CHARACTER)).json()
    r = await client.request(method, f"/api/characters/{created['id']}",
                             json={"name": "Changed"}, headers={"origin": "http://evil.example"})
    assert r.status_code == 403
    assert await characters(client) == ["Serana"]


async def test_reads_from_another_origin_are_allowed(client):
    # The browser keeps the answer from the page that asked; nothing changed.
    r = await client.get("/api/characters", headers={"origin": "http://evil.example",
                                                     "sec-fetch-site": "cross-site"})
    assert r.status_code == 200


async def test_requests_without_browser_headers_are_allowed(client):
    # curl, a script, Playwright's request fixture.
    assert (await client.post("/api/characters", json=CHARACTER)).status_code == 201


async def test_pages_outside_the_api_are_not_judged(client):
    r = await client.post("/somewhere", headers={"origin": "http://evil.example"})
    assert r.status_code != 403


async def test_the_login_is_checked_too(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        r = await c.post("/api/gate", json={"password": PW},
                         headers={"origin": "http://evil.example"})
        assert r.status_code == 403
        assert r.json() == REFUSED
        assert "set-cookie" not in r.headers
        # Refused before the lock is even looked at.
        r = await c.post("/api/characters", json=CHARACTER,
                         headers={"origin": "http://evil.example"})
        assert r.status_code == 403


async def test_a_root_path_is_judged_too(make_client):
    import httpx

    from app.main import create_app

    async with make_client():
        transport = httpx.ASGITransport(app=create_app(), root_path="/evermind")
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as prefixed:
            r = await prefixed.post("/evermind/api/characters", json=CHARACTER,
                                    headers={"origin": "http://evil.example"})
    assert r.status_code == 403
