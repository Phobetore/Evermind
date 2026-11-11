"""The built interface is served by the API's own process.

Phones keep old bookmarks and may hold an old copy of the interface, so these
tests are mostly about what is cached and what is redirected.
"""

import errno
import logging
import os

import pytest

from app.ui import UIFiles

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


async def test_chromes_devtools_probe_stays_out_of_the_access_log(ui_client, caplog):
    probe = "/.well-known/appspecific/com.chrome.devtools.json"
    assert (await ui_client.get(probe)).status_code == 404
    line = '%s - "%s %s HTTP/%s" %d'
    with caplog.at_level(logging.INFO, logger="uvicorn.access"):
        access = logging.getLogger("uvicorn.access")
        access.info(line, "127.0.0.1:1", "GET", probe, "1.1", 404)
        access.info(line, "127.0.0.1:1", "GET", "/.well-known/other.json", "1.1", 404)
    logged = [record.getMessage() for record in caplog.records]
    assert logged == ['127.0.0.1:1 - "GET /.well-known/other.json HTTP/1.1" 404']


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
    ("/chat/abc", "/#/chat/abc"), ("/chat", "/#/chat"), ("/chat/", "/#/chat/"),
    ("/characters/new", "/#/characters/new"), ("/settings", "/#/settings"),
    ("/login?from=%2Fchat%2Fabc", "/#/login?from=%2Fchat%2Fabc"),
    # The path is encoded again: a decoded "?" would start the query and a
    # decoded "#" a fragment, and the route would be another one.
    ("/chat/a%3Fb", "/#/chat/a%3Fb"), ("/chat/a%23b", "/#/chat/a%23b"),
    ("/chat/%C3%A9", "/#/chat/%C3%A9"), ("/chat/a%3Fb?x=1", "/#/chat/a%3Fb?x=1"),
])
async def test_legacy_links_redirect(ui_client, old, new):
    r = await ui_client.get(old, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == new


async def test_what_is_long_goes_out_compressed(ui_client, ui_dir):
    # A long conversation is a long answer, and a phone on a weak link is who reads it.
    (ui_dir / "assets" / "long-1f2e3d.js").write_text("console.log('a');\n" * 200, encoding="utf-8")
    long = "Terse. " * 200
    card = (await ui_client.post("/api/characters", json={"name": "Vane", "description": long})).json()
    for path in ("/assets/long-1f2e3d.js", f"/api/characters/{card['id']}"):
        r = await ui_client.get(path, headers={"Accept-Encoding": "gzip"})
        assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip", path
    assert r.json()["description"] == long


async def test_a_file_named_like_a_legacy_page_is_served(ui_client, ui_dir):
    (ui_dir / "settings").write_text("a file", encoding="utf-8")
    assert (await ui_client.get("/settings")).text == "a file"


async def test_unknown_api_path_stays_json(ui_client):
    r = await ui_client.get("/api/nope")
    assert r.status_code == 404 and r.headers["content-type"].startswith("application/json")


async def test_unknown_api_path_stays_json_for_any_method(ui_client):
    # The interface only answers GET and HEAD, and would call anything else a
    # 405 if the API's own 404 did not come first.
    r = await ui_client.post("/api/nope", json={})
    assert r.status_code == 404 and r.headers["content-type"].startswith("application/json")


async def test_api_routes_are_answered_before_the_interface_fallback(ui_client):
    r = await ui_client.get("/api/health")
    assert r.status_code == 200 and r.json()["app"] == "evermind"


async def test_the_interface_answers_head_too(ui_client):
    r = await ui_client.head("/")
    assert r.status_code == 200 and r.content == b""
    assert r.headers["cache-control"] == "no-cache"
    r = await ui_client.head("/assets/app-3f2a1b.js")
    assert r.status_code == 200 and r.headers["cache-control"] == IMMUTABLE


async def test_a_page_cannot_be_written_to(ui_client):
    r = await ui_client.post("/", json={})
    assert r.status_code == 405


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


def failing_lookup(monkeypatch, error):
    def lookup(self, path):
        raise error

    monkeypatch.setattr(UIFiles, "lookup_path", lookup)


@pytest.mark.parametrize("code, raised", [(errno.EINVAL, False), (errno.ENAMETOOLONG, False), (errno.EIO, True)])
async def test_only_a_name_the_file_system_refuses_is_a_missing_file(ui_client, monkeypatch, code, raised):
    failing_lookup(monkeypatch, OSError(code, os.strerror(code)))
    if raised:  # the disk's own failure has to show as one
        with pytest.raises(OSError):
            await ui_client.get("/assets/whatever")
    else:
        assert (await ui_client.get("/assets/whatever")).status_code == 404


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


async def test_a_folder_without_index_is_not_served(make_client, tmp_path):
    # A build that has not run yet leaves an empty folder, which must not stop
    # the API from starting.
    empty = tmp_path / "empty-ui"
    empty.mkdir()
    async with make_client(EVERMIND_UI_DIR=str(empty)) as c:
        assert (await c.get("/")).status_code == 404
        assert (await c.get("/api/health")).status_code == 200


async def test_the_tab_icon_is_served_and_revalidated(ui_client, ui_dir):
    # Vite copies public/ to the root of the build: no hash in the name, so it must not stick.
    (ui_dir / "favicon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
    r = await ui_client.get("/favicon.svg")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/svg+xml")
    assert r.headers["cache-control"] == "no-cache"
