"""Replacing a portrait used to leave the old file behind for good."""

from app.cards.png import make_placeholder_png


def _png() -> bytes:
    return make_placeholder_png(16, 16)


async def _character(client) -> dict:
    return (await client.post("/api/characters", json={"name": "Vane"})).json()


async def test_replacing_a_character_portrait_takes_the_old_one(client):
    char = await _character(client)
    first = (await client.post(f"/api/characters/{char['id']}/avatar",
                               files={"file": ("a.png", _png(), "image/png")})).json()
    await client.post(f"/api/characters/{char['id']}/avatar",
                      files={"file": ("b.png", _png(), "image/png")})
    assert (await client.get(first["avatar_url"])).status_code == 404


async def test_replacing_a_persona_portrait_takes_the_old_one(client):
    persona = (await client.post("/api/personas", json={"name": "Aymeric"})).json()
    first = (await client.post(f"/api/personas/{persona['id']}/avatar",
                               files={"file": ("a.png", _png(), "image/png")})).json()
    await client.post(f"/api/personas/{persona['id']}/avatar",
                      files={"file": ("b.png", _png(), "image/png")})
    assert (await client.get(first["avatar_url"])).status_code == 404


async def test_a_file_two_things_point_at_survives_one_of_them_letting_go(client):
    """The count is the whole safety of it. Branching gives two conversations
    the same backdrop; the same must hold for any pair of rows, so it is
    checked here at the level of the function that does the deleting."""
    from app.db import _connect
    from app.services import media

    one = await _character(client)
    two = (await client.post("/api/characters", json={"name": "Other"})).json()
    uploaded = (await client.post(f"/api/characters/{one['id']}/avatar",
                                  files={"file": ("a.png", _png(), "image/png")})).json()
    shared = uploaded["avatar_url"].removeprefix("/api/media/")

    db = await _connect()
    try:
        # No endpoint hands out a filename, so the second reference is made the
        # way branching makes one: straight in the row.
        await db.execute("UPDATE characters SET avatar_path = ? WHERE id = ?",
                         (shared, two["id"]))
        await db.commit()
        assert await media.forget(db, shared) is False, (
            "deleted a file another row still points at"
        )
    finally:
        await db.close()

    assert (await client.get(uploaded["avatar_url"])).status_code == 200


async def test_a_name_from_outside_the_media_folder_is_refused(client):
    """forget() only ever receives a name the database handed back, but it is
    the one function here that deletes, so it checks anyway."""
    from app.db import _connect
    from app.services import media

    db = await _connect()
    try:
        assert await media.forget(db, "") is False
        assert await media.forget(db, "../evermind.db") is False
        assert await media.forget(db, "does-not-exist.png") is False
    finally:
        await db.close()
