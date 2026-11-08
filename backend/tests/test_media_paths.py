r"""The media route serves a file the caller names.

Only a name Evermind gives what it stores reaches the file system. On Windows a
name such as \\host\share\x.png is a network path: a single path call opens an
SMB connection to that host, offering it the account's credentials, and holds the
server for about 20 s. A containment check after the call comes too late.
"""

import os
import urllib.parse
import uuid
from pathlib import Path

import pytest

from app.config import media_dir
from app.services import media

from .conftest import PNG

ESCAPES = [
    "../../../etc/passwd",
    "..%2f..%2f..%2fetc%2fpasswd",
    "....//....//etc/passwd",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "..\\..\\..\\Windows\\win.ini",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "subdir/../../outside.png",
]

# What the security review sent: network paths, devices, drives, and names no file could have.
WINDOWS_NAMES = [
    "\\\\192.0.2.77\\share\\x.png",
    "\\\\192.0.2.77\\s\\x.png",
    "\\\\?\\UNC\\192.0.2.77\\share\\x.png",
    "\\\\.\\pipe\\x.png",
    "\\\\?\\C:\\Windows\\win.ini",
    "C:..\\x.png",
    "C:\\Windows\\win.ini",
    "NUL",
    "CON.png",
    "x.png\0",
    "a" * 300 + ".png",
]


@pytest.mark.parametrize("attempt", ESCAPES)
async def test_media_refuses_to_leave_its_directory(client, attempt, tmp_path):
    """Nothing outside the media directory is ever served, whatever the spelling."""
    outside = media_dir().parent / "outside.png"
    outside.parent.mkdir(parents=True, exist_ok=True)
    outside.write_bytes(b"\x89PNG\r\n\x1a\n secret")

    resp = await client.get(f"/api/media/{urllib.parse.quote(attempt, safe='')}")

    assert resp.status_code in (404, 400, 405), resp.status_code
    assert b"secret" not in resp.content


@pytest.mark.parametrize("attempt", WINDOWS_NAMES)
async def test_a_name_evermind_never_gives_reaches_no_path_call(client, monkeypatch, attempt):
    """A network path is opened by the first call that looks at it, so none may be made."""
    reached = []

    def refuse(*args, **kwargs):
        reached.append(args)
        raise AssertionError(f"a path call was made: {args!r}")

    with monkeypatch.context() as patch:
        for owner, name in [(Path, "resolve"), (Path, "is_file"), (Path, "exists"), (os, "stat"),
                            (os, "lstat"), (os.path, "realpath"), (os.path, "isfile")]:
            patch.setattr(owner, name, refuse)
        resp = await client.get(f"/api/media/{urllib.parse.quote(attempt, safe='')}")

    assert (resp.status_code, reached) == (404, [])
    assert resp.json() == {"error": "File not found.", "kind": "not_found", "resource": "file"}


@pytest.mark.parametrize("spelling", [
    pytest.param(lambda name: name + "::$DATA", id="stream"),
    pytest.param(lambda name: name + ".", id="trailing dot"),
    pytest.param(lambda name: name + " ", id="trailing space"),
    pytest.param(str.upper, id="upper case"),
])
async def test_only_the_name_evermind_gave_serves_the_file(client, spelling):
    """Windows opens the same file under these spellings, which Evermind never gives."""
    name = media.save(PNG, ".png")
    other = urllib.parse.quote(spelling(name), safe="")

    assert (await client.get(f"/api/media/{other}")).status_code == 404
    assert (await client.get(f"/api/media/{name}")).status_code == 200


async def test_media_serves_a_file_that_is_actually_in_there(client):
    """The guard rejects traversal without rejecting the legitimate case."""
    name = media.save(b"\x89PNG\r\n\x1a\n fine", ".png")

    resp = await client.get(f"/api/media/{name}")

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/png")
    assert b"fine" in resp.content


async def test_media_refuses_a_symlink_pointing_out_of_the_directory(client, tmp_path):
    """resolve() follows symlinks, so the parent check has to be done after it."""
    target = tmp_path / "elsewhere.png"
    target.write_bytes(b"\x89PNG\r\n\x1a\n secret")
    link = media_dir() / f"{uuid.uuid4().hex}.png"
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("this platform will not let the test create a symlink")

    resp = await client.get(f"/api/media/{link.name}")

    assert resp.status_code == 404
    assert b"secret" not in resp.content


async def test_an_image_is_kept_by_the_browser_alone(client):
    name = media.save(PNG, ".png")

    resp = await client.get(f"/api/media/{name}")

    assert resp.headers["cache-control"] == "private, max-age=31536000, immutable"


@pytest.mark.parametrize("owner", ["characters", "personas"])
async def test_a_portrait_is_addressed_from_the_page(client, owner):
    """No leading slash, so that behind a proxy's path prefix the image is asked under it."""
    made = (await client.post(f"/api/{owner}", json={"name": "Vane"})).json()
    resp = await client.post(f"/api/{owner}/{made['id']}/avatar",
                             files={"file": ("a.png", PNG, "image/png")})

    url = resp.json()["avatar_url"]
    assert url.startswith("api/media/")
    assert (await client.get(url)).status_code == 200


@pytest.mark.parametrize("route", ["characters/nope/avatar", "personas/nope/avatar",
                                   "conversations/nope/wallpaper"])
async def test_an_upload_for_nothing_leaves_no_file(client, route):
    resp = await client.post(f"/api/{route}", files={"file": ("a.png", PNG, "image/png")})

    assert resp.status_code == 404
    assert list(media_dir().iterdir()) == []


async def test_a_library_portrait_is_one_of_a_card_the_library_lists(client, tmp_path, monkeypatch):
    """On Windows a backslash separates: a name made into a path would climb out of the library."""
    library = tmp_path / "lib"
    library.mkdir()
    for path in (library / "card.json", library / "card.jpg",
                 tmp_path / "secret.json", tmp_path / "secret.jpg"):
        path.touch()
    monkeypatch.setenv("EVERMIND_LIBRARY_DIR", str(library))

    assert (await client.get("/api/library/card.json/avatar")).status_code == 200
    assert (await client.get("/api/library/..%5Csecret.json/avatar")).status_code == 404


async def test_every_card_the_library_ships_is_listed_with_its_jpeg_portrait(client):
    """Rejecting everything would pass the test above and break the product."""
    from app.config import library_dir

    shipped = sorted(p.name for p in library_dir().glob("*.json"))
    assert shipped, "no library cards found, so this test proves nothing"
    listed = (await client.get("/api/library")).json()
    assert [(item["filename"], item["has_avatar"]) for item in listed] == [
        (name, True) for name in shipped]
    for name in shipped:
        resp = await client.get(f"/api/library/{name}/avatar")
        assert (resp.status_code, resp.headers["content-type"]) == (200, "image/jpeg"), name
