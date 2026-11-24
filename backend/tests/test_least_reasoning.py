"""A caller that wants the least reasoning a model allows: OpenRouter is told how little, from what
its own list of models says each one accepts, and no other server is asked anything."""

import asyncio
import json
import logging
import time

import httpx
import pytest

from app.providers import complete_answer
from app.providers.openai_compat import OpenAICompatProvider

from .conftest import PAYLOAD, send, setup_conversation, sse

OPENROUTER = "https://openrouter.ai/api/v1"
MODEL = "deepseek/deepseek-v4.1-flash"
HOURS = 3600.0


class OpenRouter:
    """A server that lists ``models`` (None: its list fails), answers each chat request, and
    refuses with ``refuse`` a request that carries a "reasoning" field."""

    def __init__(self, models: list[dict] | None, refuse: int | None = None):
        self.models = models
        self.refuse = refuse
        self.refuse_all: int | None = None  # a refusal of every request, the field or not
        self.list_takes = 0.0  # seconds the list takes to come
        self.lists = 0
        self.bodies: list[dict] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path.endswith("/key"):
            # OpenRouter's check of the key, which goes with each read of its list.
            return httpx.Response(200, json={"data": {}})
        if request.method == "GET":
            assert request.url.path.endswith("/models")
            self.lists += 1
            await asyncio.sleep(self.list_takes)
            if self.models is None:
                return httpx.Response(503, json={"error": {"message": "busy"}})
            # As OpenRouter answers: every model on one page, and no page after it.
            return httpx.Response(200, json={"data": self.models, "links": {"next": None}})
        body = json.loads(request.content)
        self.bodies.append(body)
        if self.refuse_all:
            return httpx.Response(self.refuse_all, json={"error": {
                "message": "This endpoint's maximum context length is 16384 tokens"}})
        if self.refuse and "reasoning" in body:
            return httpx.Response(self.refuse, json={"error": {"message": "reasoning not allowed"}})
        return httpx.Response(200, content=sse([
            json.dumps({"choices": [{"delta": {"content": "{}"}, "finish_reason": "stop"}]}),
            "[DONE]"]))

    def provider(self, connection: dict) -> OpenAICompatProvider:
        provider = OpenAICompatProvider(connection)
        provider._client_factory = lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(self.handler))
        return provider

    async def ask(self, model: str = MODEL, base_url: str = OPENROUTER, least: bool = True) -> dict:
        """The body of the chat request a pass that wants the least reasoning sends."""
        connection = {"base_url": base_url, "model": model, "max_tokens": 2048}
        if least:
            connection["least_reasoning"] = True
        answer = await complete_answer(self.provider(connection), PAYLOAD)
        assert answer.text == "{}"
        return self.bodies[-1]


def listed(reasoning: dict | None, model: str = MODEL) -> list[dict]:
    entry = {"id": model, "name": "A model"}
    if reasoning is not None:
        entry["reasoning"] = reasoning
    return [{"id": "other/model", "reasoning": {"mandatory": True}}, entry]


@pytest.fixture()
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr("app.providers.openai_compat._now", lambda: now[0])
    # The list itself is kept by the catalog, on its own clock.
    monkeypatch.setattr("app.providers.catalog._now", lambda: now[0])
    return now


THE_OWNERS = {"mandatory": False, "default_enabled": True,
              "supported_efforts": ["max", "high", "low", "none"], "default_effort": "high"}


@pytest.mark.parametrize(("reasoning", "sent"), [
    pytest.param(None, None, id="a model that does not reason"),
    pytest.param(THE_OWNERS, {"effort": "none"}, id="optional, none among its efforts"),
    pytest.param({"mandatory": False, "supported_efforts": None}, {"effort": "none"},
                 id="optional, every effort"),
    pytest.param({"mandatory": False, "supported_efforts": ["xhigh", "high"],
                  "default_effort": "high"}, {"effort": "high"},
                 id="optional, none not among its efforts"),
    pytest.param({"mandatory": False, "default_enabled": False}, {"enabled": False},
                 id="optional, no choice of effort"),
    pytest.param({"mandatory": True, "supported_efforts": ["high", "medium", "low"]},
                 {"effort": "low"}, id="mandatory, lowest is low"),
    pytest.param({"mandatory": True, "supported_efforts": ["high", "minimal", "none"]},
                 {"effort": "minimal"}, id="mandatory, none listed anyway"),
    pytest.param({"mandatory": True, "supported_efforts": None}, {"effort": "minimal"},
                 id="mandatory, every effort"),
    pytest.param({"mandatory": True}, None, id="mandatory, no choice of effort"),
])
async def test_the_least_reasoning_a_model_allows_is_asked_for(clock, reasoning, sent):
    server = OpenRouter(listed(reasoning))
    body = await server.ask()
    assert body.get("reasoning") == sent
    assert ("reasoning" in body) == (sent is not None)


async def test_a_model_missing_from_the_list_is_sent_nothing(clock):
    server = OpenRouter(listed(THE_OWNERS, model="someone/else"))
    assert "reasoning" not in await server.ask()


async def test_the_list_is_read_once_and_again_after_six_hours(clock):
    server = OpenRouter(listed(THE_OWNERS))
    await server.ask()
    clock[0] += 6 * HOURS - 1
    await server.ask()
    assert server.lists == 1
    clock[0] += 2
    assert (await server.ask())["reasoning"] == {"effort": "none"}
    assert server.lists == 2


async def test_a_list_that_cannot_be_read_adds_nothing_and_is_read_again_later(clock):
    server = OpenRouter(None)
    assert "reasoning" not in await server.ask()
    server.models = listed(THE_OWNERS)
    clock[0] += 5 * 60
    assert (await server.ask())["reasoning"] == {"effort": "none"}
    assert server.lists == 2


@pytest.mark.parametrize(("model", "sent"), [
    (f"{MODEL}:nitro", {"effort": "none"}),
    (f"{MODEL}:online", {"effort": "none"}),
    # Listed as written: its own entry, not the paid model's.
    (f"{MODEL}:free", {"effort": "low"}),
])
async def test_a_routing_suffix_is_looked_up_without_it_unless_listed_with_it(clock, model, sent):
    models = [*listed(THE_OWNERS),
              {"id": f"{MODEL}:free", "reasoning": {"mandatory": True,
                                                     "supported_efforts": ["high", "low"]}}]
    server = OpenRouter(models)
    body = await server.ask(model=model)
    assert (body["model"], body["reasoning"]) == (model, sent)


@pytest.mark.parametrize("status", [400, 404, 422])
async def test_a_server_that_refuses_the_field_is_asked_without_it_from_then_on(
        clock, caplog, status):
    server = OpenRouter(listed(THE_OWNERS), refuse=status)
    with caplog.at_level(logging.WARNING):
        await server.ask()
    assert [("reasoning" in body) for body in server.bodies] == [True, False]
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and MODEL in warnings[0]

    await server.ask()
    assert [("reasoning" in body) for body in server.bodies] == [True, False, False]


async def test_a_refusal_that_was_not_about_the_field_forgets_nothing(clock, caplog):
    """The same refusal without the field says the field was not why: the next pass, to a server
    that answers again, still asks for the least reasoning, which is what keeps its bill down."""
    from app.providers.base import ProviderError

    server = OpenRouter(listed(THE_OWNERS))
    server.refuse_all = 400
    with caplog.at_level(logging.WARNING), pytest.raises(ProviderError) as refused:
        await server.ask()
    assert "maximum context length" in refused.value.message
    assert [("reasoning" in body) for body in server.bodies] == [True, False]
    assert not [r for r in caplog.records if r.name == "app.providers.openai_compat"]

    server.refuse_all = None
    assert (await server.ask())["reasoning"] == {"effort": "none"}
    assert len(server.bodies) == 3


async def test_a_list_slow_to_come_adds_nothing_and_does_not_hold_the_request(clock, monkeypatch):
    monkeypatch.setattr("app.providers.openai_compat.LIST_TIMEOUT_S", 0.05)
    server = OpenRouter(listed(THE_OWNERS))
    server.list_takes = 5
    started = time.monotonic()
    assert "reasoning" not in await server.ask()
    assert time.monotonic() - started < 2
    # Held as a list that could not be read: not asked for on the very next request.
    await server.ask()
    assert server.lists == 1


async def test_an_odd_entry_beside_the_model_does_not_take_its_least_reasoning_away(clock):
    odd = [{"id": "x/painter", "architecture": {"output_modalities": [{"x": 1}]}},
           {"id": "x/priced", "pricing": {"prompt": "1e999999", "completion": {"x": 1}}}]
    server = OpenRouter([*odd, *listed(THE_OWNERS)])
    assert (await server.ask())["reasoning"] == {"effort": "none"}


async def test_a_read_that_fails_in_any_way_adds_nothing_and_waits_five_minutes(
        clock, monkeypatch, caplog):
    """Whatever breaks the read of the list, the pass goes out as it did before the list was read,
    says so once, and does not ask again for five minutes."""
    reads = []

    async def broken(*_, **__):
        reads.append(1)
        raise TypeError("unhashable type: 'dict'")

    monkeypatch.setattr("app.providers.catalog.read_catalog", broken)
    server = OpenRouter(listed(THE_OWNERS))
    with caplog.at_level(logging.WARNING):
        assert "reasoning" not in await server.ask()
        assert "reasoning" not in await server.ask()
    assert len(reads) == 1
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and "TypeError" in warnings[0]
    clock[0] += 5 * 60
    assert "reasoning" not in await server.ask()
    assert len(reads) == 2


async def test_a_refusal_of_another_kind_is_not_asked_again(clock):
    from app.providers.base import ProviderError

    server = OpenRouter(listed(THE_OWNERS), refuse=401)
    with pytest.raises(ProviderError):
        await server.ask()
    assert len(server.bodies) == 1


@pytest.mark.parametrize("base_url", [
    "http://localhost:11434/v1", "https://api.deepseek.com/v1", "https://openrouter.ai.evil.example/v1"])
async def test_another_server_is_asked_nothing_and_sent_nothing(clock, base_url):
    server = OpenRouter(listed(THE_OWNERS))
    body = await server.ask(base_url=base_url)
    assert "reasoning" not in body
    assert server.lists == 0


async def test_a_subdomain_of_openrouter_is_openrouter(clock):
    server = OpenRouter(listed(THE_OWNERS))
    assert (await server.ask(base_url="https://eu.openrouter.ai/api/v1"))["reasoning"]


async def test_a_caller_that_did_not_ask_is_sent_nothing(clock):
    server = OpenRouter(listed(THE_OWNERS))
    assert "reasoning" not in await server.ask(least=False)
    assert server.lists == 0


async def test_a_chat_turn_sends_no_reasoning_field(client, monkeypatch, clock):
    convo = await setup_conversation(client)
    connection = (await client.get("/api/connections")).json()[0]
    await client.put(f"/api/connections/{connection['id']}",
                     json={**connection, "base_url": OPENROUTER, "model": MODEL})
    server = OpenRouter(listed(THE_OWNERS))
    monkeypatch.setattr("app.services.chat_service.get_provider", server.provider)
    await send(client, convo["id"])
    assert server.bodies and all("reasoning" not in body for body in server.bodies)
    assert server.lists == 0
