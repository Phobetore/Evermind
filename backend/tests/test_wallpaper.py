"""A backdrop for one conversation, and how strongly it shows through."""

import pytest

from app.cards.png import make_placeholder_png
from tests.test_chat import setup_conversation


def _png() -> bytes:
    return make_placeholder_png(16, 16)


async def test_a_conversation_starts_with_no_backdrop(client):
    convo = await setup_conversation(client)
    assert convo["wallpaper_url"] is None
    assert convo["wallpaper_opacity"] == 0.25, (
        "a fresh backdrop must not arrive strong enough to bury the text"
    )


async def test_setting_and_clearing_a_backdrop(client):
    convo = await setup_conversation(client)
    resp = await client.post(f"/api/conversations/{convo['id']}/wallpaper",
                             files={"file": ("bg.png", _png(), "image/png")})
    assert resp.status_code == 200
    url = resp.json()["wallpaper_url"]
    assert url and url.startswith("/api/media/")

    assert (await client.get(url)).status_code == 200, "the image must be servable"

    fetched = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert fetched["wallpaper_url"] == url, "it must survive a reload"

    cleared = await client.delete(f"/api/conversations/{convo['id']}/wallpaper")
    assert cleared.status_code == 200
    assert cleared.json()["wallpaper_url"] is None


async def test_the_opacity_is_kept(client):
    convo = await setup_conversation(client)
    resp = await client.patch(f"/api/conversations/{convo['id']}",
                              json={"wallpaper_opacity": 0.62})
    assert resp.status_code == 200
    assert resp.json()["wallpaper_opacity"] == 0.62
    fetched = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert fetched["wallpaper_opacity"] == 0.62


@pytest.mark.parametrize("value", [-0.1, 1.4, 2])
async def test_an_opacity_outside_the_slider_is_refused(client, value):
    """The slider cannot produce these, but the endpoint is reachable without it
    and a value above 1 would paint over the conversation completely."""
    convo = await setup_conversation(client)
    resp = await client.patch(f"/api/conversations/{convo['id']}",
                              json={"wallpaper_opacity": value})
    assert resp.status_code == 422


async def test_a_file_that_is_not_an_image_is_refused(client):
    convo = await setup_conversation(client)
    resp = await client.post(f"/api/conversations/{convo['id']}/wallpaper",
                             files={"file": ("notes.txt", b"hello", "text/plain")})
    assert resp.status_code >= 400
    assert "image" in resp.json()["error"].lower(), (
        "the refusal has to name the formats, or it is just a red box"
    )


async def test_a_backdrop_belongs_to_one_conversation(client):
    """Per conversation, not per character: the same character in two stories is
    in two different places."""
    first = await setup_conversation(client)
    second = await client.post("/api/conversations",
                               json={"character_id": first["character_id"]})
    second = second.json()

    await client.post(f"/api/conversations/{first['id']}/wallpaper",
                      files={"file": ("bg.png", _png(), "image/png")})

    other = (await client.get(f"/api/conversations/{second['id']}")).json()
    assert other["wallpaper_url"] is None


async def test_a_branch_carries_the_backdrop_over(client):
    """A branch is the same scene carried on differently. Losing the picture
    behind it would read as something having gone wrong."""
    convo = await setup_conversation(client)
    await client.post(f"/api/conversations/{convo['id']}/wallpaper",
                      files={"file": ("bg.png", _png(), "image/png")})
    await client.patch(f"/api/conversations/{convo['id']}", json={"wallpaper_opacity": 0.4})

    source = (await client.get(f"/api/conversations/{convo['id']}")).json()
    last = source["messages"][-1]
    branch = (await client.post(f"/api/messages/{last['id']}/branch")).json()

    assert branch["wallpaper_url"] == source["wallpaper_url"]
    assert branch["wallpaper_opacity"] == 0.4


async def test_removing_a_backdrop_leaves_the_file_for_the_branch(client):
    """The two share one file rather than a copy of it, so clearing one must
    not blank the other."""
    convo = await setup_conversation(client)
    await client.post(f"/api/conversations/{convo['id']}/wallpaper",
                      files={"file": ("bg.png", _png(), "image/png")})
    source = (await client.get(f"/api/conversations/{convo['id']}")).json()
    branch = (await client.post(
        f"/api/messages/{source['messages'][-1]['id']}/branch")).json()

    await client.delete(f"/api/conversations/{convo['id']}/wallpaper")

    still_there = (await client.get(f"/api/conversations/{branch['id']}")).json()
    assert still_there["wallpaper_url"] == source["wallpaper_url"]
    assert (await client.get(still_there["wallpaper_url"])).status_code == 200
