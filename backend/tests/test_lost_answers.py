"""An answer lost on the way: asked again, nothing is made twice; a read says how things stand."""

import asyncio
import json

from app.providers.base import ProviderEvent

from .conftest import FakeProvider, send, setup_conversation, waiting_provider, within


async def test_an_edit_writes_the_version_it_was_typed_over(client):
    """After a lost swipe, what is typed over the version on screen goes into it, then shown."""
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


async def test_the_conversation_says_while_a_memory_pass_runs(client, monkeypatch):
    """A page whose Remember got no answer reads how it ended once no pass is running."""
    monkeypatch.setattr("app.services.chat_service.get_provider", FakeProvider)
    FakeProvider.script = [ProviderEvent(type="delta", text="Reply."), ProviderEvent(type="done")]
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    started, release, _ = waiting_provider(monkeypatch)
    FakeProvider.script = [ProviderEvent(type="delta", text=json.dumps({"facts": [], "summary": "Read."})),
                           ProviderEvent(type="done")]
    url = f"/api/conversations/{convo['id']}"

    remembering = asyncio.create_task(client.post(f"{url}/memories/extract"))
    try:
        await within(5, started.wait())
        during = (await client.get(url)).json()
    finally:
        release.set()
    assert (await within(5, remembering)).status_code == 200
    after = (await client.get(url)).json()

    assert (during["memory_running"], after["memory_running"]) == (True, False)
    assert after["summary"] == "Read."


async def test_a_conversation_read_without_its_messages_carries_all_the_rest(client):
    """What the side panel reads, every 2 s while a pass runs, of a story however long."""
    convo = await setup_conversation(client)
    url = f"/api/conversations/{convo['id']}"
    await client.patch(url, json={"summary": "So far.", "author_note": "Slowly."})

    light = (await client.get(url, params={"messages": "false"})).json()

    assert "messages" not in light
    assert (light["summary"], light["author_note"]) == ("So far.", "Slowly.")
    assert (light["memory_running"], light["memory_error"]) == (False, None)
    assert len((await client.get(url)).json()["messages"]) == len(convo["messages"]) == 1
