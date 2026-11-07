"""The media route hands a caller-supplied name to the filesystem.

CodeQL flags it, and the containment check that makes it safe is one line that
somebody could delete without noticing. These tests are what makes that deletion
show up as a failure rather than as a directory traversal.
"""

import urllib.parse

import pytest

from app.cards.png import make_placeholder_png
from app.config import media_dir

PNG = make_placeholder_png(16, 16)

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


@pytest.mark.parametrize("attempt", ESCAPES)
async def test_media_refuses_to_leave_its_directory(client, attempt, tmp_path):
    """Nothing outside the media directory is ever served, whatever the spelling."""
    outside = media_dir().parent / "outside.png"
    outside.parent.mkdir(parents=True, exist_ok=True)
    outside.write_bytes(b"\x89PNG\r\n\x1a\n secret")

    resp = await client.get(f"/api/media/{urllib.parse.quote(attempt, safe='')}")

    assert resp.status_code in (404, 400, 405), resp.status_code
    assert b"secret" not in resp.content


async def test_media_serves_a_file_that_is_actually_in_there(client):
    """The guard rejects traversal without rejecting the legitimate case."""
    media_dir().mkdir(parents=True, exist_ok=True)
    (media_dir() / "portrait.png").write_bytes(b"\x89PNG\r\n\x1a\n fine")

    resp = await client.get("/api/media/portrait.png")

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/png")
    assert b"fine" in resp.content


async def test_media_refuses_a_symlink_pointing_out_of_the_directory(client, tmp_path):
    """resolve() follows symlinks, so the parent check has to be done after it."""
    media_dir().mkdir(parents=True, exist_ok=True)
    target = tmp_path / "elsewhere.png"
    target.write_bytes(b"\x89PNG\r\n\x1a\n secret")
    link = media_dir() / "innocent.png"
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("this platform will not let the test create a symlink")

    resp = await client.get("/api/media/innocent.png")

    assert resp.status_code == 404
    assert b"secret" not in resp.content


async def test_an_image_is_kept_by_the_browser_alone(client):
    (media_dir() / "portrait.png").write_bytes(PNG)

    resp = await client.get("/api/media/portrait.png")

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


LIBRARY_ESCAPES = [
    "../../../etc/passwd",
    "../secrets.json",
    "..%2fsecrets.json",
    "/etc/passwd.json",
    "sub/dir/card.json",
    "card.json\n",
    "Card.json",
    ".hidden.json",
    "card.json.png",
    "-leading-dash.json",
]


@pytest.mark.parametrize("attempt", LIBRARY_ESCAPES)
async def test_a_library_portrait_is_one_of_a_card_the_library_lists(client, attempt):
    """The name in the URL is looked up among the cards, and is never made into a path."""
    resp = await client.get(f"/api/library/{urllib.parse.quote(attempt, safe='')}/avatar")

    assert resp.status_code == 404


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
