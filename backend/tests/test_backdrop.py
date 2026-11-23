"""What a conversation shows behind its text: the character's picture, its own wallpaper or
nothing, and how strongly; and the wallpapers chosen before the update, kept as they were."""

import sqlite3

import pytest

from app import db
from app.config import db_path
from tests.conftest import PNG, setup_conversation

DISPLAY = "020_display.sql"
MIGRATIONS = db.MIGRATIONS_DIR  # the real ones: `start` points the runner elsewhere


@pytest.fixture()
def start(tmp_path, monkeypatch):
    """Adds migration files and starts the application again, on the same database."""
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", tmp_path)

    async def start(files):
        for name, sql in files.items():
            (tmp_path / name).write_text(sql, encoding="utf-8")
        await db.init_db()

    return start


def stored(convo_id, column):
    conn = sqlite3.connect(db_path())
    try:
        return conn.execute(f"SELECT {column} FROM conversations WHERE id = ?",
                            (convo_id,)).fetchone()[0]
    finally:
        conn.close()


async def patch(client, convo, **fields) -> dict:
    resp = await client.patch(f"/api/conversations/{convo['id']}", json=fields)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def upload(client, convo) -> dict:
    resp = await client.post(f"/api/conversations/{convo['id']}/wallpaper",
                             files={"file": ("bg.png", PNG, "image/png")})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_a_new_conversation_shows_the_character_s_picture(client):
    convo = await setup_conversation(client)
    assert convo["backdrop"] == "auto"
    assert convo["backdrop_strength"] is None


async def test_choosing_a_backdrop_resets_its_strength(client):
    convo = await setup_conversation(client)
    await patch(client, convo, backdrop_strength=0.4)
    now = await patch(client, convo, backdrop="none")
    assert now["backdrop_strength"] is None
    assert now["wallpaper_opacity"] == 0.25

    assert (await upload(client, convo))["backdrop_strength"] == 0.25
    await patch(client, convo, backdrop_strength=0.8)
    assert (await patch(client, convo, backdrop="auto"))["backdrop_strength"] is None
    # The portrait's own strength is not the one the chosen picture is shown at.
    assert (await patch(client, convo, backdrop_strength=0.35))["wallpaper_opacity"] == 0.8
    assert (await patch(client, convo, backdrop="image"))["backdrop_strength"] == 0.8

    await patch(client, convo, backdrop_strength=0.7)
    assert (await patch(client, convo, backdrop="image"))["backdrop_strength"] == 0.7, (
        "choosing what is already chosen changes nothing")
    assert (await patch(client, convo, backdrop="none", backdrop_strength=0.6))[
        "backdrop_strength"] == 0.6


async def test_an_image_backdrop_needs_a_wallpaper(client):
    convo = await setup_conversation(client)
    await patch(client, convo, backdrop_strength=0.4)
    before = (await client.get(f"/api/conversations/{convo['id']}?messages=false")).json()

    resp = await client.patch(f"/api/conversations/{convo['id']}", json={"backdrop": "image"})
    assert resp.status_code == 409
    assert resp.json()["kind"] == "no_wallpaper"

    after = (await client.get(f"/api/conversations/{convo['id']}?messages=false")).json()
    assert after == before


async def test_a_strength_of_null_follows_the_device_again(client):
    convo = await setup_conversation(client)
    await patch(client, convo, backdrop_strength=0.35)
    assert stored(convo["id"], "backdrop_strength") == 0.35
    assert (await patch(client, convo, backdrop_strength=None))["backdrop_strength"] is None
    assert stored(convo["id"], "backdrop_strength") is None


async def test_a_page_from_before_sets_the_strength_it_sees(client):
    convo = await setup_conversation(client)
    await upload(client, convo)
    now = await patch(client, convo, wallpaper_opacity=0.5)
    assert now["backdrop_strength"] == 0.5
    assert now["wallpaper_opacity"] == 0.5


async def test_a_strength_is_also_written_where_the_previous_version_reads_it(client):
    convo = await setup_conversation(client)
    await upload(client, convo)
    await patch(client, convo, backdrop_strength=0.3)
    assert stored(convo["id"], "wallpaper_opacity") == 0.3


async def test_uploading_and_removing_a_wallpaper(client):
    convo = await setup_conversation(client)
    sent = await upload(client, convo)
    assert (sent["backdrop"], sent["backdrop_strength"]) == ("image", 0.25)

    await patch(client, convo, backdrop_strength=0.7)
    replaced = await upload(client, convo)
    assert (replaced["backdrop"], replaced["backdrop_strength"]) == ("image", 0.7)

    resp = await client.delete(f"/api/conversations/{convo['id']}/wallpaper")
    assert resp.status_code == 200
    removed = resp.json()
    assert (removed["backdrop"], removed["backdrop_strength"]) == ("auto", None)
    assert removed["wallpaper_url"] is None

    # A new file is a new picture: it starts low, whatever the one before was shown at.
    await upload(client, convo)
    await patch(client, convo, backdrop_strength=0.8)
    await client.delete(f"/api/conversations/{convo['id']}/wallpaper")
    again = await upload(client, convo)
    assert (again["backdrop_strength"], again["wallpaper_opacity"]) == (0.25, 0.25)

    await patch(client, convo, backdrop="none", backdrop_strength=0.6)
    last = await upload(client, convo)
    assert (last["backdrop"], last["backdrop_strength"]) == ("image", 0.25)


async def test_a_branch_keeps_its_backdrop(client):
    convo = await setup_conversation(client)
    await patch(client, convo, backdrop="none", backdrop_strength=0.4)
    source = (await client.get(f"/api/conversations/{convo['id']}")).json()
    branch = (await client.post(f"/api/messages/{source['messages'][-1]['id']}/branch")).json()
    assert (branch["backdrop"], branch["backdrop_strength"]) == ("none", 0.4)


@pytest.mark.parametrize("value", [1.2, -0.1])
async def test_a_strength_out_of_bounds_is_refused(client, value):
    convo = await setup_conversation(client)
    resp = await client.patch(f"/api/conversations/{convo['id']}",
                              json={"backdrop_strength": value})
    assert resp.status_code == 422


async def test_the_update_keeps_every_wallpaper_and_its_strength(start):
    # Every migration of the release before, whatever their number: another may have come since.
    before = {path.name: path.read_text(encoding="utf-8")
              for path in sorted(MIGRATIONS.glob("*.sql")) if path.name != DISPLAY}
    display = (MIGRATIONS / DISPLAY).read_text(encoding="utf-8")
    await start(before)

    conn = sqlite3.connect(db_path())
    try:
        conn.execute("INSERT INTO characters (id, name, avatar_path, created_at, updated_at)"
                     " VALUES ('c', 'Serana', 'serana.png', 'now', 'now')")
        conn.executemany(
            "INSERT INTO conversations (id, character_id, wallpaper_path, wallpaper_opacity,"
            " created_at, updated_at) VALUES (?, 'c', ?, ?, 'now', 'now')",
            [("plain", "", 0.25), ("low", "low.png", 0.25), ("high", "high.png", 0.8)])
        conn.commit()
    finally:
        conn.close()

    await start({DISPLAY: display})

    conn = sqlite3.connect(db_path())
    try:
        rows = conn.execute("SELECT id, backdrop, backdrop_strength, wallpaper_path,"
                            " wallpaper_opacity FROM conversations ORDER BY id").fetchall()
        character = conn.execute("SELECT avatar_path, avatar_thumb_path, avatar_backdrop_path,"
                                 " excerpt, excerpt_rule FROM characters").fetchall()
    finally:
        conn.close()
    assert rows == [("high", "image", 0.8, "high.png", 0.8),
                    ("low", "image", 0.25, "low.png", 0.25),
                    ("plain", "auto", None, "", 0.25)]
    assert character == [("serana.png", "", "", None, 0)]
