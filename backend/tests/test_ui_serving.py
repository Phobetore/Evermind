"""The built interface is served by the API's own process.

Phones keep old bookmarks and may hold an old copy of the interface, so these
tests are mostly about what is cached and what is redirected.
"""

import pytest

IMMUTABLE = "public, max-age=31536000, immutable"


@pytest.fixture()
def ui_dir(tmp_path):
    root = tmp_path / "ui"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text('<!doctype html><div id="root"></div>', encoding="utf-8")
    (root / "assets" / "app-3f2a1b.js").write_text("console.log('app')", encoding="utf-8")
    return root


@pytest.fixture()
async def ui_client(make_client, ui_dir):
    async with make_client(EVERMIND_UI_DIR=str(ui_dir)) as c:
        yield c


async def test_index_is_never_cached(ui_client):
    r = await ui_client.get("/")
    assert r.status_code == 200 and 'id="root"' in r.text
    assert r.headers["cache-control"] == "no-cache"


async def test_hashed_assets_are_immutable(ui_client):
    r = await ui_client.get("/assets/app-3f2a1b.js")
    assert r.status_code == 200
    assert r.headers["cache-control"] == IMMUTABLE


async def test_revalidated_asset_stays_immutable(ui_client):
    first = await ui_client.get("/assets/app-3f2a1b.js")
    again = await ui_client.get("/assets/app-3f2a1b.js",
                                headers={"If-None-Match": first.headers["etag"]})
    assert again.status_code == 304
    assert again.headers["cache-control"] == IMMUTABLE


async def test_a_missing_asset_is_not_cached(ui_client):
    r = await ui_client.get("/assets/app-000000.js")
    assert r.status_code == 404
    assert "immutable" not in r.headers.get("cache-control", "")


async def test_files_outside_assets_are_revalidated(ui_client, ui_dir):
    (ui_dir / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    r = await ui_client.get("/favicon.svg")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("old, new", [
    ("/chat/abc", "/#/chat/abc"), ("/chat", "/#/chat"),
    ("/characters/new", "/#/characters/new"), ("/characters/abc/edit", "/#/characters/abc/edit"),
    ("/personas", "/#/personas"), ("/settings", "/#/settings"),
    ("/login?from=%2Fchat%2Fabc", "/#/login?from=%2Fchat%2Fabc"),
])
async def test_legacy_links_redirect(ui_client, old, new):
    r = await ui_client.get(old, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == new


async def test_legacy_redirect_answers_head_too(ui_client):
    r = await ui_client.head("/chat/abc", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/#/chat/abc"


async def test_unknown_api_path_stays_json(ui_client):
    r = await ui_client.get("/api/nope")
    assert r.status_code == 404 and r.headers["content-type"].startswith("application/json")


async def test_unknown_api_path_stays_json_for_any_method(ui_client):
    # The static mount only answers GET and HEAD, and would call anything else
    # a 405 if the API's own 404 did not come first.
    r = await ui_client.post("/api/nope", json={})
    assert r.status_code == 404 and r.headers["content-type"].startswith("application/json")


async def test_api_routes_still_answer_with_the_ui_mounted(ui_client):
    r = await ui_client.get("/api/health")
    assert r.status_code == 200 and r.json()["app"] == "evermind"


async def test_ui_is_public_when_password_is_set(make_client, ui_dir):
    async with make_client(EVERMIND_UI_DIR=str(ui_dir), EVERMIND_GATE_PASSWORD="hunter2") as c:
        assert (await c.get("/")).status_code == 200
        assert (await c.get("/assets/app-3f2a1b.js")).status_code == 200
        assert (await c.get("/chat/x", follow_redirects=False)).status_code == 302
        assert (await c.get("/api/characters")).status_code == 401


@pytest.mark.parametrize("path", [
    "/assets/..%2F..%2Fsecret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
    "/%2e%2e/secret.txt",
    "/..%2Fsecret.txt",
    "/../secret.txt",
])
async def test_traversal_is_refused(ui_client, tmp_path, path):
    # Next to the served folder, which is where a path that climbs out lands.
    (tmp_path / "secret.txt").write_text("top secret", encoding="utf-8")
    r = await ui_client.get(path)
    assert r.status_code == 404
    assert "top secret" not in r.text


async def test_no_cors_headers(ui_client):
    r = await ui_client.get("/api/health", headers={"Origin": "http://localhost:3000"})
    assert r.status_code == 200
    assert "access-control-allow-origin" not in r.headers


async def test_preflight_is_not_answered(ui_client):
    r = await ui_client.options("/api/health", headers={
        "Origin": "http://localhost:3000", "Access-Control-Request-Method": "GET",
    })
    assert "access-control-allow-origin" not in r.headers


async def test_without_built_ui_root_is_404(client):
    assert (await client.get("/")).status_code == 404


async def test_without_built_ui_old_links_are_not_redirected(client):
    r = await client.get("/chat/abc", follow_redirects=False)
    assert r.status_code == 404


async def test_a_folder_without_index_is_not_mounted(make_client, tmp_path):
    # A build that has not run yet leaves an empty folder, which must not stop
    # the API from starting.
    empty = tmp_path / "empty-ui"
    empty.mkdir()
    async with make_client(EVERMIND_UI_DIR=str(empty)) as c:
        assert (await c.get("/")).status_code == 404
        assert (await c.get("/api/health")).status_code == 200
