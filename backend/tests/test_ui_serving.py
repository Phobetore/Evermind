"""The built interface is served by the API's own process.

Phones keep old bookmarks and may hold an old copy of the interface, so these
tests are mostly about what is cached and what is redirected.
"""

import re
from urllib.parse import urljoin

import pytest

from .test_gate import open_socket

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


async def test_a_missing_asset_is_not_cached(ui_client, ui_dir):
    # With a 404.html in the build, a missing file is answered with that page
    # and goes through the same code as a file that was found, which is where
    # the status has to keep the long cache lifetime away from it. Without one
    # the answer is an exception that never gets that far.
    (ui_dir / "404.html").write_text("<!doctype html><p>Gone</p>", encoding="utf-8")
    r = await ui_client.get("/assets/app-000000.js")
    assert r.status_code == 404 and "Gone" in r.text
    assert r.headers["cache-control"] == "no-cache"


async def test_a_missing_file_without_a_404_page_is_not_cached_either(ui_client):
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
    # A trailing slash does not stop an old link from working.
    ("/personas/", "/#/personas/"), ("/settings/", "/#/settings/"), ("/login/", "/#/login/"),
    ("/chat/", "/#/chat/"),
    # The path goes through as it was written: a decoded "?" would start the
    # query, a decoded "#" a fragment, and the route would be another one.
    ("/chat/a%3Fb", "/#/chat/a%3Fb"), ("/chat/a%23b", "/#/chat/a%23b"),
    ("/chat/a%2Fb", "/#/chat/a%2Fb"), ("/chat/a%20b", "/#/chat/a%20b"),
    ("/chat/%C3%A9", "/#/chat/%C3%A9"), ("/chat/a%3Fb?x=1", "/#/chat/a%3Fb?x=1"),
])
async def test_legacy_links_redirect(ui_client, old, new):
    r = await ui_client.get(old, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == new


@pytest.mark.parametrize("old, new", [
    # uvicorn puts the prefix in front of the path it hands over.
    ("/evermind/chat/abc", "/evermind/#/chat/abc"),
    ("/evermind/chat", "/evermind/#/chat"),
    ("/evermind/personas/", "/evermind/#/personas/"),
    ("/evermind/login?from=%2Fchat%2Fabc", "/evermind/#/login?from=%2Fchat%2Fabc"),
    ("/evermind/chat/a%3Fb", "/evermind/#/chat/a%3Fb"),
    # A server that leaves the prefix out of the path.
    ("/chat/abc", "/evermind/#/chat/abc"),
])
async def test_legacy_links_redirect_inside_the_root_path(make_client, ui_dir, old, new):
    async with make_client(EVERMIND_UI_DIR=str(ui_dir), root_path="/evermind") as c:
        r = await c.get(old, follow_redirects=False)
        assert r.status_code == 302 and r.headers["location"] == new


async def test_the_interface_loads_inside_a_root_path(make_client, ui_dir):
    # What Vite builds refers to its files relatively ("./assets/..."), which is
    # what lets the same build work under a prefix.
    (ui_dir / "index.html").write_text(
        '<!doctype html><script type="module" src="./assets/app-3f2a1b.js"></script>',
        encoding="utf-8",
    )
    async with make_client(EVERMIND_UI_DIR=str(ui_dir), root_path="/evermind") as c:
        page = await c.get("/evermind/")
        assert page.status_code == 200
        src = re.search(r'src="([^"]+)"', page.text).group(1)
        script = await c.get(urljoin("/evermind/", src))
        assert script.status_code == 200 and script.headers["cache-control"] == IMMUTABLE
        # Without the slash, those relative addresses would lead outside the prefix.
        bare = await c.get("/evermind", follow_redirects=False)
        assert bare.status_code == 307 and bare.headers["location"] == "http://localhost/evermind/"
        assert (await c.get("/evermind/api/health")).status_code == 200
        unknown = await c.get("/evermind/api/nope")
        assert unknown.status_code == 404
        assert unknown.headers["content-type"].startswith("application/json")
        again = await c.get("/evermind/api/health/", follow_redirects=False)
        assert again.status_code == 307
        assert again.headers["location"] == "http://localhost/evermind/api/health"


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


async def test_a_known_api_route_with_the_wrong_method_is_a_405(ui_client):
    r = await ui_client.put("/api/health", json={})
    assert r.status_code == 405
    assert "GET" in r.headers["allow"]


async def test_a_known_api_route_with_a_trailing_slash_is_redirected(ui_client):
    r = await ui_client.get("/api/health/", follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"] == "http://localhost/api/health"


async def test_a_write_to_an_api_route_with_a_trailing_slash_is_redirected_as_one(ui_client):
    # 307 asks the client to send the same request again, body included.
    r = await ui_client.post("/api/characters/", json={"name": "Serana"}, follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"] == "http://localhost/api/characters"


async def test_the_interface_answers_head_too(ui_client):
    r = await ui_client.head("/")
    assert r.status_code == 200 and r.content == b""
    assert r.headers["cache-control"] == "no-cache"
    r = await ui_client.head("/assets/app-3f2a1b.js")
    assert r.status_code == 200 and r.headers["cache-control"] == IMMUTABLE


async def test_a_page_cannot_be_written_to(ui_client):
    assert (await ui_client.post("/", json={})).status_code == 405


@pytest.mark.parametrize("path", ["/nope", "/api/nope"])
async def test_a_websocket_to_a_path_nobody_serves_is_closed(make_client, ui_dir, path):
    from app.main import create_app

    async with make_client(EVERMIND_UI_DIR=str(ui_dir)):
        assert await open_socket(create_app(), {}, path=path) == ["websocket.close 1000"]


async def test_ui_is_public_when_password_is_set(make_client, ui_dir):
    async with make_client(EVERMIND_UI_DIR=str(ui_dir), EVERMIND_GATE_PASSWORD="hunter2") as c:
        assert (await c.get("/")).status_code == 200
        assert (await c.get("/assets/app-3f2a1b.js")).status_code == 200
        assert (await c.get("/chat/x", follow_redirects=False)).status_code == 302
        assert (await c.get("/api/characters")).status_code == 401


@pytest.mark.parametrize("path", [
    # The client decodes these before the application sees them, so they reach it
    # as /assets/../../secret.txt and /../secret.txt. A literal /../ would be
    # resolved by the client and never arrive, and writing the same two paths
    # with %2e for the dots adds nothing.
    "/assets/..%2F..%2Fsecret.txt",
    "/..%2Fsecret.txt",
])
async def test_traversal_is_refused(ui_client, tmp_path, path):
    # Next to the served folder, which is where a path that climbs out lands.
    (tmp_path / "secret.txt").write_text("top secret", encoding="utf-8")
    r = await ui_client.get(path)
    assert r.status_code == 404
    assert "top secret" not in r.text


@pytest.mark.parametrize("path", [
    # Names that Windows does not accept in a file name, which the lookup then
    # reports as an error of its own. Anywhere else they are just not there.
    "/assets/x*y", "/assets/x%0D%0Ay", "/x%0Ay", "/assets/x%22y", "/assets/x%00y",
])
async def test_a_name_the_file_system_refuses_is_a_missing_file(ui_client, path):
    r = await ui_client.get(path)
    assert r.status_code == 404


async def test_a_link_out_of_the_folder_is_not_followed(ui_client, ui_dir, tmp_path):
    outside = tmp_path / "secret.txt"
    outside.write_text("top secret", encoding="utf-8")
    try:
        (ui_dir / "assets" / "leak.txt").symlink_to(outside)
    except (OSError, NotImplementedError):
        # Windows only allows it to an administrator or with developer mode.
        pytest.skip("symbolic links cannot be created here")
    r = await ui_client.get("/assets/leak.txt")
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
