"""What a page can count on when the answer to what it asked for was lost on the way, as on a phone
over a home Wi-Fi: asked for again, nothing is made twice, and what it reads says how things stand."""


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
