"""A turn's end carries what the page would ask for next: what the conversation's AI reads of it
under its way, and what the conversation has cost, so that a reply costs the phone no request
of its own for them."""

from app.services import calls, turns

from .conftest import messages_of, send, within
from .helpers import add_model
from .test_calls_capture import SERVED, answered, held, hosted_story, lists, two_pieces_in
from .test_my_ais_api import KEY, OPENROUTER, Model, conversation_on
from .test_ways_api import no_memory_pass

__all__ = ["lists"]  # a fixture, used by name


async def state_of(client, convo_id: str) -> dict:
    resp = await client.get(f"/api/conversations/{convo_id}/turn")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def what_the_page_would_ask(client, convo_id: str) -> tuple[dict, dict]:
    await calls.drain()
    glance = (await client.get(f"/api/conversations/{convo_id}/outlook?only=current")).json()
    spent = (await client.get(f"/api/spending/total?conversation={convo_id}&days=all")).json()
    return glance["current"], spent


async def priced_story(client, monkeypatch) -> dict:
    await no_memory_pass(client)
    ai = await add_model(client, base_url=OPENROUTER, model=SERVED, api_key=KEY, name="Aurore",
                         as_added=True)
    convo = await conversation_on(client, ai["id"])
    usage = {"prompt_tokens": 1200, "completion_tokens": 340, "cost": 0.0021}
    Model(answered("*She nods.*", usage), answered("*She smiles.*", usage)).serve(monkeypatch)
    return convo


async def test_a_turn_end_says_what_the_next_turn_reads(client, lists, monkeypatch):
    convo = await priced_story(client, monkeypatch)
    assert await send(client, convo["id"]) is None

    state = await state_of(client, convo["id"])
    glance, spent = await what_the_page_would_ask(client, convo["id"])
    assert state["running"] is False
    assert state["glance"] == glance
    assert state["spent"] == spent
    assert (spent["calls"], spent["total"]) == (1, 0.0021)


async def test_a_stopped_turn_says_it_too(client, monkeypatch):
    await no_memory_pass(client)
    _, convo = await hosted_story(client)
    Model(held).serve(monkeypatch)
    turn = await two_pieces_in(client, convo["id"])
    assert (await client.delete(f"/api/conversations/{convo['id']}/turn")).status_code == 204
    await within(5, turn.finished.wait())

    state = await state_of(client, convo["id"])
    glance, spent = await what_the_page_would_ask(client, convo["id"])
    assert (state["glance"], state["spent"]) == (glance, spent)
    assert spent["calls"] == 1


async def test_no_glance_once_the_story_moved(client, lists, monkeypatch):
    convo = await priced_story(client, monkeypatch)
    assert await send(client, convo["id"]) is None
    assert (await state_of(client, convo["id"]))["glance"] is not None

    reply = (await messages_of(client, convo["id"]))[-1]
    assert (await client.delete(f"/api/messages/{reply['id']}")).status_code == 204

    state = await state_of(client, convo["id"])
    assert (state["glance"], state["spent"]) == (None, None)


async def test_a_new_turn_forgets_the_last_end(client, lists, monkeypatch):
    convo = await priced_story(client, monkeypatch)
    assert await send(client, convo["id"]) is None
    assert turns.end_of(convo["id"]) is not None

    Model(held).serve(monkeypatch)
    turn = await two_pieces_in(client, convo["id"])
    assert turns.end_of(convo["id"]) is None, "the end of the turn before outlived the next one"
    assert (await client.delete(f"/api/conversations/{convo['id']}/turn")).status_code == 204
    await within(5, turn.finished.wait())
    assert turns.end_of(convo["id"]) is not None
