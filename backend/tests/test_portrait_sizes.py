"""The smaller copies of a portrait, made by a browser and kept by the server: named by it, refused
when their portrait changed meanwhile, and never a file deleted that the request did not write."""

import re
import sqlite3

import pytest

from app.config import db_path, media_dir
from app.repositories import characters as repo
from app.services import media
from tests.conftest import PNG, setup_conversation

# Enough of each format for the server, which reads only how a file begins.
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + bytes(24)
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + bytes(24)
STORED = re.compile(r"api/media/[0-9a-f]{32}\.(webp|jpg)")


async def make_character(client) -> dict:
    char = (await client.post("/api/characters", json={"name": "Serana"})).json()
    return await new_portrait(client, char)


async def new_portrait(client, char) -> dict:
    resp = await client.post(f"/api/characters/{char['id']}/avatar",
                             files={"file": ("serana.png", PNG, "image/png")})
    assert resp.status_code == 200, resp.text
    return resp.json()


def portrait_of(char) -> str:
    return char["avatar_url"].rsplit("/", 1)[-1]


async def send_sizes(client, char_id, portrait, grid=(WEBP, "image/webp"),
                     backdrop=(WEBP, "image/webp"), headers=None):
    return await client.post(
        f"/api/characters/{char_id}/avatar/sizes", data={"portrait": portrait},
        files={"grid": ("grid", grid[0], grid[1]), "backdrop": ("backdrop", backdrop[0], backdrop[1])},
        headers=headers)


def files() -> set[str]:
    return {path.name for path in media_dir().iterdir()}


async def test_sizes_are_kept_and_named_by_the_server(client):
    char = await make_character(client)
    grid, backdrop = WEBP + b"grid", WEBP + b"backdrop"
    resp = await send_sizes(client, char["id"], portrait_of(char),
                            (grid, "image/webp"), (backdrop, "image/webp"))
    assert resp.status_code == 200, resp.text
    kept = resp.json()
    assert STORED.fullmatch(kept["avatar_thumb_url"])
    assert STORED.fullmatch(kept["avatar_backdrop_url"])
    assert kept["avatar_thumb_url"].endswith(".webp")
    assert (await client.get(kept["avatar_thumb_url"])).content == grid
    assert (await client.get(kept["avatar_backdrop_url"])).content == backdrop
    assert kept["updated_at"] == char["updated_at"], "copies are no edit"
    assert kept["lore_entries"] == [], "the object a character's own page reads"
    for column in ("avatar_thumb_path", "avatar_backdrop_path", "excerpt", "excerpt_rule"):
        assert column not in kept

    listed = (await client.get("/api/characters")).json()[0]
    assert (listed["avatar_thumb_url"], listed["avatar_backdrop_url"]) == (
        kept["avatar_thumb_url"], kept["avatar_backdrop_url"])


async def test_a_jpeg_copy_is_kept_too(client):
    char = await make_character(client)
    resp = await send_sizes(client, char["id"], portrait_of(char),
                            (JPEG, "image/jpeg"), (JPEG, "image/jpeg"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["avatar_thumb_url"].endswith(".jpg")
    assert resp.json()["avatar_backdrop_url"].endswith(".jpg")


@pytest.mark.parametrize("grid", [
    (PNG, "image/png"),
    (JPEG, "image/webp"),
    (b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "image/webp"),
    (b"<!doctype html><script>alert(1)</script>", "image/webp"),
    (b"<!doctype html><script>alert(1)</script>", "image/jpeg"),
    (WEBP, "image/jpeg"),
    (b"RIFF\x24\x00\x00\x00WAVEfmt " + bytes(24), "image/webp"),
    (b"RIFF\x24\x00\x00\x00", "image/webp"),
])
async def test_a_png_or_a_lying_file_is_refused(client, grid):
    char = await make_character(client)
    before = files()
    resp = await send_sizes(client, char["id"], portrait_of(char), grid)
    assert resp.status_code == 400
    assert resp.json()["kind"] == "unsupported_image"
    # The other copy, fine on its own, is not written either.
    resp = await send_sizes(client, char["id"], portrait_of(char), (WEBP, "image/webp"), grid)
    assert resp.status_code == 400
    assert files() == before
    assert (await client.get(f"/api/characters/{char['id']}")).json()["avatar_thumb_url"] is None


async def test_sizes_of_a_portrait_replaced_meanwhile_are_refused_and_not_kept(client):
    char = await make_character(client)
    old = portrait_of(char)
    char = await new_portrait(client, char)
    before = files()
    resp = await send_sizes(client, char["id"], old)
    assert resp.status_code == 409
    assert resp.json()["kind"] == "portrait_changed"
    now = (await client.get(f"/api/characters/{char['id']}")).json()
    assert (now["avatar_thumb_url"], now["avatar_backdrop_url"]) == (None, None)
    assert files() == before


async def test_the_second_device_to_send_sizes_leaves_the_first_ones(client):
    char = await make_character(client)
    first = (await send_sizes(client, char["id"], portrait_of(char))).json()
    before = files()
    resp = await send_sizes(client, char["id"], portrait_of(char),
                            (JPEG, "image/jpeg"), (JPEG, "image/jpeg"))
    assert resp.status_code == 200, resp.text
    second = resp.json()
    assert (second["avatar_thumb_url"], second["avatar_backdrop_url"]) == (
        first["avatar_thumb_url"], first["avatar_backdrop_url"])
    assert files() == before, "the second set is written, then deleted"


async def test_a_refusal_deletes_only_what_it_wrote(client):
    convo = await setup_conversation(client)
    wallpaper = (await client.post(f"/api/conversations/{convo['id']}/wallpaper",
                                   files={"file": ("bg.png", PNG, "image/png")})).json()
    char = await new_portrait(client, {"id": convo["character_id"]})
    old = portrait_of(char)
    copies = (await send_sizes(client, char["id"], old)).json()
    await new_portrait(client, char)

    assert (await send_sizes(client, char["id"], old)).status_code == 409

    for url in (char["avatar_url"], copies["avatar_thumb_url"], copies["avatar_backdrop_url"],
                wallpaper["wallpaper_url"]):
        assert (media_dir() / url.rsplit("/", 1)[-1]).is_file(), url


async def test_a_new_portrait_has_no_copies(client):
    char = await make_character(client)
    await send_sizes(client, char["id"], portrait_of(char))
    from app.db import _connect
    db = await _connect()
    await db.execute("UPDATE characters SET updated_at = '2026-01-01' WHERE id = ?", (char["id"],))
    await db.commit()
    await db.close()

    char = await new_portrait(client, char)
    assert (char["avatar_thumb_url"], char["avatar_backdrop_url"]) == (None, None)
    assert char["updated_at"] > "2026-01-01", "a new portrait is an edit"


async def test_sizes_of_an_unknown_character(client):
    await make_character(client)
    before = files()
    # A copy that would be refused: only a check made before any file is read answers 404.
    resp = await send_sizes(client, "nobody", "0" * 32 + ".png", (PNG, "image/png"))
    assert resp.status_code == 404
    assert (resp.json()["kind"], resp.json()["resource"]) == ("not_found", "character")
    assert files() == before


@pytest.mark.parametrize("portrait", [
    "../x.png", "x.png", "../" + "a" * 32 + ".png", "a" * 32 + ".png\n", "a" * 32 + ".gif",
    "A" * 32 + ".png",
])
async def test_a_portrait_name_the_server_never_gives_is_refused(client, portrait):
    char = await make_character(client)
    before = files()
    resp = await send_sizes(client, char["id"], portrait)
    assert resp.status_code == 422
    assert files() == before


async def test_another_origin_cannot_send_sizes(client):
    char = await make_character(client)
    resp = await send_sizes(client, char["id"], portrait_of(char),
                            headers={"origin": "https://evil.example"})
    assert resp.status_code == 403
    assert resp.json()["kind"] == "cross_origin"


async def test_discard_touches_only_names_it_gave(client):
    await make_character(client)
    media.discard("../evermind.db")
    media.discard("x.png")
    media.discard("0" * 32 + ".png")
    # A name the server gives, inside a path that leaves media/: Windows resolves the .. by text.
    beside = media_dir().parent / ("0" * 32 + ".png")
    beside.write_bytes(PNG)
    media.discard("0" * 32 + ".png/../../evermind.db")
    media.discard("../" + "0" * 32 + ".png")
    assert db_path().is_file()
    assert beside.is_file()
    assert (await client.get("/api/characters")).status_code == 200


@pytest.mark.parametrize("extension, own", [
    (".png", PNG), (".jpg", JPEG), (".webp", WEBP),
])
def test_matches_type_knows_each_signature(extension, own):
    assert media.matches_type(own, extension)
    for other in (PNG, JPEG, WEBP, b"<!doctype html>", b"RIFF\x24\x00\x00\x00WAVEfmt "):
        if other is not own:
            assert not media.matches_type(other, extension), other[:12]


async def test_copies_written_by_a_request_that_fails_are_deleted(client, monkeypatch):
    char = await make_character(client)
    before = files()

    async def locked(*args):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(repo, "keep_sizes", locked)
    with pytest.raises(sqlite3.OperationalError):
        await send_sizes(client, char["id"], portrait_of(char))
    assert files() == before


async def test_a_copy_that_cannot_be_written_leaves_none_behind(client, monkeypatch):
    char = await make_character(client)
    before = files()
    save = media.save
    written = []

    def full(data, extension):
        if written:
            raise OSError(28, "No space left on device")
        written.append(save(data, extension))
        return written[-1]

    monkeypatch.setattr(media, "save", full)
    with pytest.raises(OSError):
        await send_sizes(client, char["id"], portrait_of(char))
    assert written and files() == before


async def test_discard_deletes_a_file_it_saved(client):
    name = media.save(WEBP, ".webp")
    media.discard(name)
    assert not (media_dir() / name).exists()
