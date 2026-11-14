"""A text refused for its length says so, with the bound and its own length, wherever it is sent:
the interface has one sentence for it, not "something is missing or not valid"."""


async def test_a_text_over_its_bound_says_which_bound_and_how_long_it_is(client):
    resp = await client.post("/api/personas", json={"name": "x" * 201})
    assert resp.status_code == 422
    body = resp.json()
    assert (body["kind"], body["params"]) == ("text_too_long", {"limit": 200, "length": 201})
    assert body["detail"][0]["loc"] == ["body", "name"]


async def test_a_text_under_its_bound_says_which_bound_and_how_long_it_is(client):
    resp = await client.post("/api/characters/assist", json={"prompt": "ab"})
    assert resp.status_code == 422
    body = resp.json()
    assert (body["kind"], body["params"]) == ("text_too_short", {"limit": 3, "length": 2})


async def test_a_length_counts_characters_as_a_person_does(client):
    # An emoji is one character, as the box it was typed in counts it.
    resp = await client.post("/api/personas", json={"name": "🌊" * 201})
    assert resp.json()["params"] == {"limit": 200, "length": 201}


async def test_another_refusal_names_no_length(client):
    resp = await client.post("/api/personas", json={"name": 5})
    assert resp.status_code == 422
    assert "kind" not in resp.json() and "params" not in resp.json()
