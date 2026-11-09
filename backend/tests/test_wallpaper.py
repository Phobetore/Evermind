"""A backdrop for one conversation, and how strongly it shows through."""

import pytest

from tests.conftest import PNG, setup_conversation


async def test_setting_and_clearing_a_backdrop(client):
    convo = await setup_conversation(client)
    resp = await client.post(f"/api/conversations/{convo['id']}/wallpaper",
                             files={"file": ("bg.png", PNG, "image/png")})
    assert resp.status_code == 200
    url = resp.json()["wallpaper_url"]
    assert url and url.startswith("api/media/")

    assert (await client.get(url)).status_code == 200, "the image must be servable"

    fetched = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert fetched["wallpaper_url"] == url, "it must survive a reload"

    cleared = await client.delete(f"/api/conversations/{convo['id']}/wallpaper")
    assert cleared.status_code == 200
    assert cleared.json()["wallpaper_url"] is None


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


async def test_a_branch_carries_the_backdrop_and_the_directive_over(client):
    """A branch is the same scene carried on differently. Losing the picture
    behind it, or the directive, would read as something having gone wrong."""
    convo = await setup_conversation(client)
    await client.post(f"/api/conversations/{convo['id']}/wallpaper",
                      files={"file": ("bg.png", PNG, "image/png")})
    await client.patch(f"/api/conversations/{convo['id']}", json={
        "wallpaper_opacity": 0.4, "author_note": "Never end a reply mid-sentence.",
    })

    source = (await client.get(f"/api/conversations/{convo['id']}")).json()
    last = source["messages"][-1]
    branch = (await client.post(f"/api/messages/{last['id']}/branch")).json()

    assert branch["wallpaper_url"] == source["wallpaper_url"]
    assert branch["wallpaper_opacity"] == 0.4
    assert branch["author_note"] == "Never end a reply mid-sentence."
