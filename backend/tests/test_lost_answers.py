"""What a page can count on when the answer to what it asked for was lost on the way, as on a phone
over a home Wi-Fi: asked for again, nothing is made twice, and what it reads says how things stand."""

import asyncio

from .conftest import setup_conversation


async def test_an_edit_writes_the_version_it_was_typed_over(client):
    """A swipe whose answer was lost leaves the page on another version than the server's: what is
    typed over the version on screen goes into that one, which is then the one shown."""
    char = (await client.post("/api/characters", json={
        "name": "Serana", "greeting": "First.", "alternate_greetings": ["Second."]})).json()
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    url = f"/api/messages/{convo['messages'][0]['id']}"
    assert (await client.patch(url, json={"active_index": 1})).status_code == 200

    resp = await client.patch(url, json={"content": "First, put right.", "active_index": 0})

    assert resp.status_code == 200, resp.text
    saved = resp.json()
    assert saved["variants"] == ["First, put right.", "Second."]
    assert (saved["active_index"], saved["content"]) == (0, "First, put right.")
    refused = await client.patch(url, json={"content": "Nowhere.", "active_index": 2})
    assert (refused.status_code, refused.json()["kind"]) == (400, "variant_out_of_range")
    message = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"][0]
    assert message["variants"] == ["First, put right.", "Second."]


async def test_a_conversation_asked_for_again_under_its_id_is_the_one_made(client):
    """Enter the story, its answer lost, and Enter again: one conversation, not two."""
    char = (await client.post("/api/characters", json={"name": "Serana"})).json()
    asked = {"character_id": char["id"], "client_id": "start-1"}

    made = [await client.post("/api/conversations", json=asked) for _ in range(2)]

    assert [r.status_code for r in made] == [201, 201]
    assert made[1].json()["id"] == made[0].json()["id"]
    other = await client.post("/api/conversations", json={**asked, "client_id": "start-2"})
    assert other.json()["id"] != made[0].json()["id"]
    assert len((await client.get("/api/conversations")).json()) == 2


async def test_a_branch_asked_for_again_under_its_id_is_the_one_made(client):
    """Two taps at once, or one tried again after its answer was lost: one branch."""
    convo = await setup_conversation(client)
    url = f"/api/messages/{convo['messages'][0]['id']}/branch"
    asked = {"client_id": "fork-1"}

    together = await asyncio.gather(*(client.post(url, json=asked) for _ in range(2)))
    again = await client.post(url, json=asked)

    assert [r.status_code for r in [*together, again]] == [201, 201, 201]
    assert len({r.json()["id"] for r in [*together, again]}) == 1
    assert (await client.post(url)).status_code == 201  # with no id, one more each time, as before
    branches = [c for c in (await client.get("/api/conversations")).json() if c["forked_from"]]
    assert len(branches) == 2
