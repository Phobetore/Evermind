"""Every request to a model leaves its row: each pass of a reply, the pen, each ask of a memory
pass or a consolidation, and the speed test; however it ended, and with what it served.

The OpenRouter pieces below are written by hand in the shapes OpenRouter documents."""

import asyncio
import json
import sqlite3

import httpx
import pytest

from app.config import db_path
from app.providers.base import AUTH_REFUSED
from app.services import calls, memory_service, turns

from .conftest import messages_of, send, sse, within
from .helpers import add_model, cap
from .test_calls_record import rows
from .test_learning import OPENAI_TOO_LONG, a_story, long_story
from .test_memory import EXTRACTION_JSON, add_facts
from .test_memory_room import finish, writing
from .test_my_ais_api import HOSTED, KEY, OPENROUTER, Lists, Model, conversation_on, services_of

GENERATION = "gen-or-1"
SERVED = "aurore/aurore-large"


def piece(**delta) -> str:
    """One piece of a reply as OpenRouter streams it: its generation, the model and the provider
    that served it."""
    return json.dumps({"id": GENERATION, "model": SERVED, "provider": "Lumen",
                       "choices": [{"delta": delta, "finish_reason": None}]})


def counted(usage: dict, reason: str = "stop") -> str:
    return json.dumps({"id": GENERATION, "model": SERVED, "provider": "Lumen",
                       "choices": [{"delta": {}, "finish_reason": reason}], "usage": usage})


def answered(text: str, usage: dict) -> list[str]:
    return [piece(content=text), counted(usage), "[DONE]"]


async def recorded(purpose: str | None = None) -> list[dict]:
    """The rows once every write beside a call is done, oldest first."""
    await calls.drain()
    return [r for r in rows() if purpose is None or r["purpose"] == purpose]


async def hosted_story(client) -> tuple[dict, dict]:
    ai = await add_model(client, base_url=HOSTED, model="aurore", name="Aurore")
    return ai, await conversation_on(client, ai["id"])


class Held(httpx.AsyncByteStream):
    """Two pieces of a reply, then nothing more until the reader gives up."""

    async def __aiter__(self):
        yield sse([piece(content="*She "), piece(content="waits")])
        await asyncio.Event().wait()


def held() -> httpx.Response:
    return httpx.Response(200, stream=Held(), headers={"content-type": "text/event-stream"})


async def two_pieces_in(client, convo_id: str):
    resp = await client.post("/api/chat", json={"conversation_id": convo_id, "mode": "send",
                                                "content": "Hello"})
    assert resp.status_code == 200, resp.text
    turn = await turns.running_for(convo_id)

    async def written():
        while "waits" not in turn.text:
            await asyncio.sleep(0.01)

    await within(5, written())
    return turn


class Released(httpx.AsyncByteStream):
    """``lines`` once ``release`` is set; ``started`` says the request came."""

    def __init__(self, started: asyncio.Event, release: asyncio.Event, lines: list[str]):
        self.started, self.release, self.lines = started, release, lines

    async def __aiter__(self):
        self.started.set()
        await self.release.wait()
        yield sse(self.lines)


# The replies.


@pytest.fixture()
def lists(monkeypatch) -> Lists:
    from app.providers import catalog

    served = Lists({"/api/v1/models": {"data": [{"id": SERVED}]}, "/api/v1/key": {"data": {}}})
    monkeypatch.setattr(catalog, "client_factory", served.factory)
    return served


async def test_a_whole_reply_is_one_row_with_its_story(client, lists, monkeypatch):
    ai = await add_model(client, base_url=OPENROUTER, model=SERVED, api_key=KEY, name="Aurore",
                         as_added=True)
    convo = await conversation_on(client, ai["id"])
    usage = {"prompt_tokens": 1200, "completion_tokens": 340, "cost": 0.0021}
    Model(answered("*She nods.*", usage)).serve(monkeypatch)
    assert await send(client, convo["id"], content="Hello there") is None

    reply = (await messages_of(client, convo["id"]))[-1]
    [row] = await recorded()
    assert (row["purpose"], row["attempt"], row["outcome"]) == ("reply", 0, "whole")
    assert (row["conversation_id"], row["conversation_title"]) == (convo["id"], "Hello there")
    assert (row["card_id"], row["card_name"], row["card_kind"]) == (
        convo["character_id"], "Serana", "character")
    assert (row["message_id"], row["variant"]) == (reply["id"], 0)
    service = (await services_of(client))[0]
    assert (row["model_id"], row["model_name"], row["service_name"]) == (
        ai["id"], "Aurore", service["name"])
    assert (row["generation_id"], row["model_served"], row["upstream"]) == (
        GENERATION, SERVED, "Lumen")
    assert (row["tokens_in"], row["tokens_out"], row["tokens_source"]) == (1200, 340, "server")
    assert (row["cost"], row["cost_source"]) == (0.0021, "reported")


async def test_regenerate_and_continue_name_their_variant(client, monkeypatch):
    _, convo = await hosted_story(client)
    Model(writing("*She nods.*")).serve(monkeypatch)
    await send(client, convo["id"])
    await send(client, convo["id"], mode="regenerate")
    await send(client, convo["id"], mode="continue")

    reply = (await messages_of(client, convo["id"]))[-1]
    found = [(r["purpose"], r["variant"], r["message_id"]) for r in await recorded()]
    assert found[1:] == [("regenerate", 1, reply["id"]), ("continue", 1, reply["id"])]


async def test_the_greeting_fold_is_two_rows(client, monkeypatch):
    _, convo = await hosted_story(client)
    Model([finish("stop"), "[DONE]"], writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None

    reply = (await messages_of(client, convo["id"]))[-1]
    found = [(r["attempt"], r["outcome"], r["message_id"]) for r in await recorded()]
    assert found == [(0, "empty", reply["id"]), (1, "whole", reply["id"])]


async def test_a_too_long_refusal_then_its_retry_are_two_rows(client, monkeypatch):
    _, convo = await a_story(client, context_own=None)
    await long_story(convo["id"], 22, 1000)
    model = Model((400, {"error": {"message": OPENAI_TOO_LONG}}), writing("*She nods.*")
                  ).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    assert len(model.bodies) == 2

    refused, retried = await recorded()
    assert (refused["attempt"], refused["outcome"], refused["status"]) == (0, "refused", 400)
    assert (refused["tokens_in"], refused["tokens_out"], refused["cost"]) == (0, 0, 0)
    assert (retried["attempt"], retried["outcome"]) == (1, "whole")


async def test_a_reply_stopped_midway_is_one_stopped_row(client, monkeypatch):
    _, convo = await hosted_story(client)
    Model(held).serve(monkeypatch)
    turn = await two_pieces_in(client, convo["id"])
    assert (await client.delete(f"/api/conversations/{convo['id']}/turn")).status_code == 204
    await within(5, turn.finished.wait())

    [row] = await recorded()
    assert (row["outcome"], row["tokens_source"]) == ("stopped", "estimated")
    assert row["tokens_out"] == calls.estimated_out(len("*She waits")) > 0
    assert row["generation_id"] == GENERATION


async def test_an_error_in_the_stream_is_failed_with_what_came(client, monkeypatch):
    _, convo = await hosted_story(client)
    lines = [piece(content="*She "), counted({"prompt_tokens": 900, "completion_tokens": 3}, None),
             json.dumps({"error": {"message": "The upstream went away."}})]
    Model(lines).serve(monkeypatch)
    outcome = await send(client, convo["id"])
    assert outcome["kind"] == "model_error"

    [row] = await recorded()
    assert (row["outcome"], row["status"], row["tokens_in"]) == ("failed", None, 900)
    # An OpenAI-compatible server's count is its last whenever it gives one.
    assert (row["tokens_out"], row["tokens_source"]) == (3, "server")


async def test_a_server_going_down_leaves_stopped_rows(client, monkeypatch):
    _, convo = await hosted_story(client)
    Model(held).serve(monkeypatch)
    turn = await two_pieces_in(client, convo["id"])
    turn.task.cancel()  # what a server shutting down does to it
    await within(5, turn.finished.wait())

    [row] = await recorded()
    assert (row["outcome"], row["tokens_source"]) == ("stopped", "estimated")
    assert row["tokens_out"] > 0 and row["ended_at"] is not None


async def test_a_server_that_counts_nothing_is_estimated_with_its_ratio(client, monkeypatch):
    ai, convo = await hosted_story(client)
    conn = sqlite3.connect(db_path())
    try:
        conn.execute("UPDATE models SET token_ratio = 1.2, token_ratio_n = 3 WHERE id = ?",
                     (ai["id"],))
        conn.commit()
    finally:
        conn.close()
    Model(writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None

    used = (await messages_of(client, convo["id"]))[-1]["meta"]["context"]["used_tokens"]
    [row] = await recorded()
    assert (row["tokens_in"], row["tokens_source"]) == (round(used * 1.2), "estimated")
    assert (row["cost"], row["cost_source"]) == (None, "none")


async def test_a_refused_include_usage_is_one_row(client, monkeypatch):
    _, convo = await hosted_story(client)
    refusal = (400, {"error": {"message": "Unrecognized request argument supplied: "
                                          "stream_options"}})
    model = Model(refusal, writing("*She nods.*")).serve(monkeypatch)
    assert await send(client, convo["id"]) is None
    assert len(model.bodies) == 2

    assert [(r["attempt"], r["outcome"]) for r in await recorded()] == [(0, "whole")]


async def test_a_byok_reply_lands_with_its_upstream(client, monkeypatch):
    _, convo = await hosted_story(client)
    # shape unverified: OpenRouter's cost_details.upstream_inference_cost with a key of one's own.
    usage = {"prompt_tokens": 1000, "completion_tokens": 100, "cost": 0,
             "cost_details": {"upstream_inference_cost": 0.0123}}
    Model(answered("*She nods.*", usage)).serve(monkeypatch)
    assert await send(client, convo["id"]) is None

    [row] = await recorded()
    assert (row["cost"], row["cost_upstream"], row["cost_source"]) == (0, 0.0123, "reported")


# The pen.


async def test_the_pen_is_counted(client, monkeypatch):
    _, convo = await hosted_story(client)
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    await send(client, convo["id"])
    model.answers = [writing("I take her hand.")]
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert (resp.status_code, resp.json()) == (200, {"text": "I take her hand."})

    model.answers = [(401, {"error": {"message": "No auth credentials found"}})]
    refused = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert (refused.status_code, refused.json()["kind"]) == (502, AUTH_REFUSED)

    # Spaces are no text: the pen says so, and the row too.
    model.answers = [writing("   ")]
    blank = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert (blank.status_code, blank.json()["kind"]) == (502, "model_empty")

    found = [(r["outcome"], r["status"], r["conversation_id"]) for r in await recorded("pen")]
    assert found == [("whole", None, convo["id"]), ("refused", 401, convo["id"]),
                     ("empty", None, convo["id"])]


# The memory.


async def test_a_memory_pass_thrown_away_is_counted(client, monkeypatch):
    _, convo = await hosted_story(client)
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    await send(client, convo["id"])
    extract = f"/api/conversations/{convo['id']}/memories/extract"

    model.answers = [writing("Not JSON.")]
    assert (await client.post(extract)).json()["kind"] == "model_unreadable"

    started, release = asyncio.Event(), asyncio.Event()
    model.answers = [lambda: httpx.Response(200, stream=Released(started, release,
                                                                 writing(EXTRACTION_JSON)))]
    asking = asyncio.create_task(client.post(extract))
    try:
        await within(5, started.wait())
        reply = (await messages_of(client, convo["id"]))[-1]
        assert (await client.delete(f"/api/messages/{reply['id']}")).status_code == 204
    finally:
        release.set()
    assert (await within(5, asking)).json()["kind"] == "conversation_changed"

    model.answers = [writing(EXTRACTION_JSON)]
    assert (await client.post(extract)).status_code == 200

    found = [(r["outcome"], r["conversation_id"], r["message_id"])
             for r in await recorded("memory")]
    assert found == [("discarded", convo["id"], None), ("discarded", convo["id"], None),
                     ("whole", convo["id"], None)]


async def test_a_memory_pass_asked_again_is_two_rows(client, monkeypatch):
    ai, convo = await hosted_story(client)
    await client.put(f"/api/models/{ai['id']}", json=cap(300))
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    await send(client, convo["id"])
    model.answers, model.bodies = [writing('{"facts": [', stop="length"),
                                   writing(EXTRACTION_JSON)], []
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.status_code == 200, resp.text
    assert [body.get("max_tokens") for body in model.bodies] == [2048, 8192]

    found = [(r["attempt"], r["outcome"]) for r in await recorded("memory")]
    assert found == [(0, "discarded"), (1, "whole")]


async def test_a_second_ask_cut_by_the_server_stopping_discards_the_first(client, monkeypatch):
    ai, convo = await hosted_story(client)
    await client.put(f"/api/models/{ai['id']}", json=cap(300))
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    await send(client, convo["id"])
    started = asyncio.Event()
    model.answers, model.bodies = [
        writing('{"facts": [', stop="length"),
        lambda: httpx.Response(200, stream=Released(started, asyncio.Event(), []))], []
    asking = asyncio.create_task(client.post(f"/api/conversations/{convo['id']}/memories/extract"))
    await within(5, started.wait())
    await memory_service.stop()
    await asyncio.gather(asking, return_exceptions=True)

    found = [(r["attempt"], r["outcome"]) for r in await recorded("memory")]
    assert found == [(0, "discarded"), (1, "stopped")]


async def test_a_second_ask_refused_leaves_the_first_discarded(client, monkeypatch):
    ai, convo = await hosted_story(client)
    await client.put(f"/api/models/{ai['id']}", json=cap(300))
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    await send(client, convo["id"])
    model.answers, model.bodies = [writing('{"facts": [', stop="length"),
                                   (400, {"error": {"message": "max_tokens is too large"}})], []
    resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
    assert resp.json()["kind"] == "model_unreadable"

    found = [(r["attempt"], r["outcome"], r["status"]) for r in await recorded("memory")]
    assert found == [(0, "discarded", None), (1, "refused", 400)]


async def test_a_learned_room_refused_then_its_own_ceiling_are_two_rows(client, monkeypatch):
    ai, convo = await hosted_story(client)
    await client.put(f"/api/models/{ai['id']}", json=cap(300))
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    await send(client, convo["id"])
    extract = f"/api/conversations/{convo['id']}/memories/extract"
    model.answers, model.bodies = [writing('{"facts": [', stop="length"),
                                   writing(EXTRACTION_JSON)], []
    assert (await client.post(extract)).status_code == 200
    model.answers, model.bodies = [writing("*She smiles.*")], []
    await send(client, convo["id"], content="More")
    model.answers, model.bodies = [(400, {"error": {"message": "max_tokens is too large"}}),
                                   writing(EXTRACTION_JSON)], []
    assert (await client.post(extract)).status_code == 200
    assert [body.get("max_tokens") for body in model.bodies] == [8192, 2048]

    found = [(r["attempt"], r["outcome"]) for r in await recorded("memory")]
    assert found[2:] == [(0, "refused"), (1, "whole")]


async def facts_changed_while_asked(client, monkeypatch, path: str, answer: str) -> dict:
    """The memory operation at ``path``, a fact it was sent forgotten while the model answers."""
    _, convo = await hosted_story(client)
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    await send(client, convo["id"])
    await add_facts(client, convo["id"], [f"Redundant fact number {i}." for i in range(10)],
                    by_the_model=True)
    fact = (await client.get(f"/api/conversations/{convo['id']}/memories")).json()[0]
    started, release = asyncio.Event(), asyncio.Event()
    model.answers = [lambda: httpx.Response(200, stream=Released(started, release,
                                                                 writing(answer)))]
    asking = asyncio.create_task(client.post(f"/api/conversations/{convo['id']}{path}"))
    try:
        await within(5, started.wait())
        assert (await client.delete(f"/api/memories/{fact['id']}")).status_code == 204
    finally:
        release.set()
    return (await within(5, asking)).json()


async def test_a_memory_pass_refused_for_a_fact_changed_is_discarded(client, monkeypatch):
    answered = await facts_changed_while_asked(client, monkeypatch, "/memories/extract",
                                               EXTRACTION_JSON)
    assert answered["kind"] == "facts_changed"
    assert [r["outcome"] for r in await recorded("memory")] == ["discarded"]


async def test_a_consolidation_refused_for_a_fact_changed_is_discarded(client, monkeypatch):
    merged = json.dumps({"facts": [{"content": "One dense fact."}]})
    answered = await facts_changed_while_asked(client, monkeypatch, "/memories/consolidate", merged)
    assert answered["kind"] == "facts_changed"
    assert [r["outcome"] for r in await recorded("consolidation")] == ["discarded"]


async def test_consolidation_is_counted_apart(client, monkeypatch):
    _, convo = await hosted_story(client)
    await add_facts(client, convo["id"], [f"Redundant fact number {i}." for i in range(10)],
                    by_the_model=True)
    model = Model(writing("Not JSON.")).serve(monkeypatch)
    consolidate = f"/api/conversations/{convo['id']}/memories/consolidate"
    assert (await client.post(consolidate)).json()["kind"] == "model_unreadable"
    model.answers = [writing(json.dumps({"facts": [{"content": "One dense fact."}]}))]
    assert (await client.post(consolidate)).status_code == 200

    found = [(r["purpose"], r["outcome"], r["conversation_id"]) for r in await recorded()]
    assert found == [("consolidation", "discarded", convo["id"]),
                     ("consolidation", "whole", convo["id"])]


# The speed test.


async def test_the_speed_test_is_counted(client, monkeypatch):
    ai = await add_model(client, base_url=HOSTED, model="aurore", name="Aurore")
    model = Model(writing("Rain falls on the quiet street."))
    monkeypatch.setattr("app.routers.models.get_provider", model.provider)
    resp = await client.post(f"/api/models/{ai['id']}/benchmark")
    assert resp.status_code == 200, resp.text

    [row] = await recorded()
    assert (row["purpose"], row["outcome"], row["conversation_id"], row["model_id"]) == (
        "speed", "whole", None, ai["id"])
    assert row["tokens_in"] > 0

    # Spaces are no text: the measure answers as before, and its row is empty.
    model.answers = [writing("   ")]
    assert (await client.post(f"/api/models/{ai['id']}/benchmark")).status_code == 200
    assert [r["outcome"] for r in await recorded("speed")] == ["whole", "empty"]
