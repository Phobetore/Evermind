"""A memory pass whose model answered nothing readable: asked once more with room when it ran out
of it, and told apart by how it ended when it still gave nothing."""

import asyncio
import json
import logging
from types import SimpleNamespace

import httpx
import pytest

from app.errors import MODEL_ONLY_THOUGHT, MODEL_WITHHELD
from app.providers.openai_compat import OpenAICompatProvider
from app.services import memory_service

from .conftest import send, setup_conversation, sse
from .test_memory import EXTRACTION_JSON, Said, add_facts


def chunk(**delta) -> str:
    return json.dumps({"choices": [{"delta": delta}]})


def finish(reason) -> str:
    return json.dumps({"choices": [{"delta": {}, "finish_reason": reason}]})


def thinking(characters: int, stop="length") -> list[str]:
    """An answer that is only reasoning, and how the server ended it."""
    return [chunk(reasoning_content="x" * characters), finish(stop), "[DONE]"]


def writing(text: str, stop="stop") -> list[str]:
    return [chunk(content=text), finish(stop), "[DONE]"]


class Server:
    """A model's server that gives each request the next scripted answer (a number is a refusal
    with that status), and keeps the bodies it was sent."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.bodies: list[dict] = []
        self.connections: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.bodies.append(json.loads(request.content))
        answer = self.answers[min(len(self.bodies), len(self.answers)) - 1]
        if isinstance(answer, int):
            return httpx.Response(answer, json={"error": {"message": "max_tokens is too large"}})
        return httpx.Response(200, content=sse(answer),
                              headers={"content-type": "text/event-stream"})

    def provider(self, connection: dict) -> OpenAICompatProvider:
        self.connections.append(connection)
        provider = OpenAICompatProvider(connection)
        provider._client_factory = lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(self.handler))
        return provider

    def asked(self) -> list:
        return [body.get("max_tokens") for body in self.bodies]


@pytest.fixture()
async def story(client, monkeypatch):
    """A conversation with one exchange, and hooks to put a server in the memory pass's place."""
    monkeypatch.setattr("app.services.chat_service.get_provider", Said)
    convo = await setup_conversation(client)
    await send(client, convo["id"])

    def serve(*answers) -> Server:
        server = Server(*answers)
        monkeypatch.setattr("app.services.memory_service.get_provider", server.provider)
        return server

    async def set_connection(**fields):
        connection = (await client.get("/api/connections")).json()[0]
        await client.put(f"/api/connections/{connection['id']}", json={**connection, **fields})

    async def extract():
        return await client.post(f"/api/conversations/{convo['id']}/memories/extract")

    return SimpleNamespace(id=convo["id"], client=client, serve=serve,
                           set_connection=set_connection, extract=extract)


async def test_a_readable_first_answer_is_the_only_request(story):
    await story.set_connection(max_tokens=300)
    server = story.serve(writing(EXTRACTION_JSON))
    resp = await story.extract()
    assert resp.status_code == 200, resp.text
    assert server.asked() == [2048]


async def test_a_consolidation_wants_the_least_reasoning(story):
    await facts_to_merge(story)
    server = story.serve(writing(json.dumps({"facts": [{"content": "One dense fact."}]})))
    resp = await story.client.post(f"/api/conversations/{story.id}/memories/consolidate")
    assert resp.status_code == 200, resp.text
    assert server.connections[0]["least_reasoning"] is True


async def test_an_extraction_wants_the_least_reasoning(story):
    server = story.serve(writing(EXTRACTION_JSON))
    assert (await story.extract()).status_code == 200
    assert [c.get("least_reasoning") for c in server.connections] == [True]


async def test_a_model_that_spent_its_room_thinking_is_asked_again_with_more(story):
    await story.set_connection(max_tokens=300)
    server = story.serve(thinking(5120), writing(EXTRACTION_JSON))
    resp = await story.extract()
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["facts_added"]) == 2
    assert server.asked() == [2048, memory_service.MORE_ROOM_TOKENS] == [2048, 8192]


async def test_more_room_is_four_times_a_large_ceiling(story):
    await story.set_connection(max_tokens=4000, context_size=100000)
    server = story.serve(thinking(10), writing(EXTRACTION_JSON))
    assert (await story.extract()).status_code == 200
    assert server.asked() == [4000, 16000]


async def test_a_json_cut_midway_is_asked_again_with_more_room(story):
    await story.set_connection(max_tokens=300)
    server = story.serve(writing(EXTRACTION_JSON[:40], stop="length"), writing(EXTRACTION_JSON))
    resp = await story.extract()
    assert resp.status_code == 200, resp.text
    assert len(server.bodies) == 2
    assert len(resp.json()["facts_added"]) == 2


async def test_a_model_that_only_thinks_twice_is_told_so_after_two_requests(story, caplog):
    await story.set_connection(max_tokens=300)
    server = story.serve(thinking(5120), thinking(9000))
    with caplog.at_level(logging.WARNING):
        resp = await story.extract()
    assert resp.status_code == 502
    assert resp.json()["kind"] == MODEL_ONLY_THOUGHT
    assert "more max tokens" in resp.json()["error"]
    assert len(server.bodies) == 2
    # A warning, as the server's console shows no less, and one that says what to change.
    lines = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert lines[0] == (
        "memory extraction: the model ran out of room (5120 characters of reasoning, stopped "
        "with 'length', max_tokens 2048); asking again with 8192. Raising the connection's max "
        "tokens avoids the second call.")
    failure = next(r.getMessage() for r in caplog.records if "unreadable answer" in r.getMessage())
    assert "9000 characters of reasoning" in failure and "'length'" in failure


async def test_an_answer_the_server_withheld_is_named_and_not_asked_again(story, caplog):
    await story.set_connection(max_tokens=300)
    server = story.serve([finish("content_filter"), "[DONE]"])
    with caplog.at_level(logging.WARNING):
        resp = await story.extract()
    assert resp.status_code == 502
    assert resp.json() == {"error": "The model's server withheld the answer (\"content_filter\").",
                           "kind": MODEL_WITHHELD, "reason": "content_filter"}
    assert len(server.bodies) == 1
    assert any("unreadable answer" in r.getMessage() and "'content_filter'" in r.getMessage()
               for r in caplog.records)


async def test_a_second_request_the_server_refuses_gives_the_first_failure(story, caplog):
    await story.set_connection(max_tokens=300)
    server = story.serve(thinking(5120), 400)
    with caplog.at_level(logging.WARNING):
        resp = await story.extract()
    assert resp.status_code == 502
    assert resp.json()["kind"] == MODEL_ONLY_THOUGHT
    assert len(server.bodies) == 2
    assert any("max_tokens is too large" in r.getMessage() for r in caplog.records)


async def test_a_context_with_no_more_room_is_not_asked_again(story):
    await story.set_connection(max_tokens=300, context_size=1024)
    server = story.serve(thinking(5120))
    resp = await story.extract()
    assert resp.status_code == 502
    assert resp.json()["kind"] == MODEL_ONLY_THOUGHT
    assert len(server.bodies) == 1


async def test_a_connection_with_no_ceiling_that_only_thought_is_not_asked_again(story):
    await story.set_connection(max_tokens=None)
    server = story.serve(thinking(500, stop="stop"))
    resp = await story.extract()
    assert resp.json()["kind"] == MODEL_ONLY_THOUGHT
    assert len(server.bodies) == 1


async def test_an_empty_answer_that_ran_out_of_room_says_so(story):
    """Its server may count the reasoning against the room and still not send it."""
    await story.set_connection(max_tokens=None)
    server = story.serve([finish("length"), "[DONE]"], [finish("length"), "[DONE]"])
    resp = await story.extract()
    assert resp.json()["kind"] == MODEL_ONLY_THOUGHT
    assert len(server.bodies) == 2


async def test_an_automatic_pass_that_only_thought_keeps_why(client, monkeypatch):
    monkeypatch.setattr("app.services.chat_service.get_provider", Said)
    convo = await setup_conversation(client)
    connection = (await client.get("/api/connections")).json()[0]
    await client.put(f"/api/connections/{connection['id']}", json={**connection, "max_tokens": 300})
    server = Server(thinking(5120), thinking(5120))
    monkeypatch.setattr("app.services.memory_service.get_provider", server.provider)
    for n in range(memory_service.MAINTENANCE_EVERY):
        await send(client, convo["id"], content=f"exchange {n}")
    await asyncio.gather(*[t for t in asyncio.all_tasks() if "schedule_if_due" in repr(t)])
    assert memory_service.failure_of(convo["id"])["kind"] == MODEL_ONLY_THOUGHT


async def test_the_room_a_model_needed_is_where_the_next_pass_starts(story):
    await story.set_connection(max_tokens=300)
    server = story.serve(thinking(5120), writing(EXTRACTION_JSON), writing(EXTRACTION_JSON))
    assert (await story.extract()).status_code == 200
    await send(story.client, story.id, content="More")
    assert (await story.extract()).status_code == 200
    assert server.asked() == [2048, 8192, 8192]


async def test_a_model_that_ran_out_where_it_had_learned_to_start_is_asked_again_once(story):
    await story.set_connection(max_tokens=300, context_size=100000)
    server = story.serve(thinking(5120), writing(EXTRACTION_JSON), thinking(9000),
                         thinking(9000))
    assert (await story.extract()).status_code == 200
    await send(story.client, story.id, content="More")
    assert (await story.extract()).json()["kind"] == MODEL_ONLY_THOUGHT
    assert server.asked() == [2048, 8192, 8192, 32768]


async def test_a_second_ask_that_only_thought_again_teaches_nothing(story):
    await story.set_connection(max_tokens=300)
    server = story.serve(thinking(5120), thinking(9000), writing(EXTRACTION_JSON))
    assert (await story.extract()).status_code == 502
    await send(story.client, story.id, content="More")
    assert (await story.extract()).status_code == 200
    assert server.asked() == [2048, 8192, 2048]


async def test_a_second_ask_the_server_refused_teaches_nothing(story):
    await story.set_connection(max_tokens=300)
    server = story.serve(thinking(5120), 400, writing(EXTRACTION_JSON))
    assert (await story.extract()).status_code == 502
    await send(story.client, story.id, content="More")
    assert (await story.extract()).status_code == 200
    assert server.asked() == [2048, 8192, 2048]


async def test_a_learned_room_the_server_now_refuses_is_forgotten(story, caplog):
    """A server whose output limit came down refuses where the pass had learned to start: the pass
    asks with the connection's own ceiling, which it took before, and the next one starts there."""
    await story.set_connection(max_tokens=300)
    server = story.serve(thinking(5120), writing(EXTRACTION_JSON), 400, writing(EXTRACTION_JSON),
                         writing(EXTRACTION_JSON))
    assert (await story.extract()).status_code == 200
    await send(story.client, story.id, content="More")
    with caplog.at_level(logging.WARNING):
        resp = await story.extract()
    assert resp.status_code == 200, resp.text
    assert any("max_tokens is too large" in r.getMessage() for r in caplog.records)
    await send(story.client, story.id, content="Again")
    assert (await story.extract()).status_code == 200
    assert server.asked() == [2048, 8192, 8192, 2048, 2048]


async def test_a_refused_learned_room_is_not_asked_for_again_in_the_same_pass(story):
    """The ask at the connection's own ceiling is the pass's second: it runs out, and that is told."""
    await story.set_connection(max_tokens=300)
    server = story.serve(thinking(5120), writing(EXTRACTION_JSON), 400, thinking(5120),
                         writing(EXTRACTION_JSON))
    assert (await story.extract()).status_code == 200
    await send(story.client, story.id, content="More")
    assert (await story.extract()).json()["kind"] == MODEL_ONLY_THOUGHT
    assert server.asked() == [2048, 8192, 8192, 2048]


async def test_the_room_learned_is_cut_to_what_a_longer_prompt_leaves(story, monkeypatch):
    await story.set_connection(max_tokens=300, context_size=16384)
    prompt = [1000]
    monkeypatch.setattr("app.services.memory_service.prompt_tokens", lambda _: prompt[0])
    server = story.serve(thinking(5120), writing(EXTRACTION_JSON), writing(EXTRACTION_JSON))
    assert (await story.extract()).status_code == 200
    prompt[0] = 12000
    await send(story.client, story.id, content="More")
    assert (await story.extract()).status_code == 200
    assert server.asked() == [2048, 8192, 16384 - 12000 - 128]


async def test_a_connection_with_no_ceiling_is_asked_again_only_with_the_full_room(story):
    """Less than that could be below the server's own default, which just ran out."""
    await story.set_connection(max_tokens=None, context_size=4096)
    server = story.serve([finish("length"), "[DONE]"], writing(EXTRACTION_JSON))
    resp = await story.extract()
    assert resp.json()["kind"] == MODEL_ONLY_THOUGHT
    assert server.asked() == [None]


async def facts_to_merge(story):
    await add_facts(story.client, story.id, [f"Redundant fact number {i}." for i in range(10)],
                    by_the_model=True)


async def test_a_consolidation_is_asked_again_with_more_room_and_then_merges(story):
    await story.set_connection(max_tokens=300)
    await facts_to_merge(story)
    merged = json.dumps({"facts": [{"content": "One dense fact."}]})
    server = story.serve(thinking(5120), writing(merged))
    resp = await story.client.post(f"/api/conversations/{story.id}/memories/consolidate")
    assert resp.status_code == 200, resp.text
    assert server.asked() == [2048, 8192]
    assert [m["content"] for m in resp.json()["memories"]] == ["One dense fact."]


async def test_a_consolidation_the_server_withheld_is_named(story):
    await facts_to_merge(story)
    server = story.serve([finish("content_filter"), "[DONE]"])
    resp = await story.client.post(f"/api/conversations/{story.id}/memories/consolidate")
    assert resp.status_code == 502
    assert (resp.json()["kind"], resp.json()["reason"]) == (MODEL_WITHHELD, "content_filter")
    assert len(server.bodies) == 1
