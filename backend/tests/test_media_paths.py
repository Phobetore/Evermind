"""The media route hands a caller-supplied name to the filesystem.

CodeQL flags it, and the containment check that makes it safe is one line that
somebody could delete without noticing. These tests are what makes that deletion
show up as a failure rather than as a directory traversal.
"""

import urllib.parse

import pytest

from app.config import media_dir

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
def test_library_names_outside_the_allowlist_are_refused(attempt):
    """The library reads a file whose name comes from the URL. The allowlist is
    what keeps that from being a way to read the rest of the disk, so it gets a
    test rather than a comment."""
    from app.routers.library import _image_path, _read_card

    assert _read_card(attempt) is None
    assert _image_path(attempt) is None


def test_library_accepts_the_names_it_actually_ships():
    """Rejecting everything would pass the test above and break the product."""
    from app.config import library_dir
    from app.routers.library import _SAFE_NAME

    shipped = sorted(p.name for p in library_dir().glob("*.json"))
    assert shipped, "no library cards found, so this test proves nothing"
    for name in shipped:
        assert _SAFE_NAME.match(name), name
