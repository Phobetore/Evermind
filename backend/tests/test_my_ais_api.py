"""Services that hold the key once, and the AIs on them: what the API keeps, what it reads from a
server, what it sends each model, and what a page from before the update can still do."""

import asyncio
import json
import logging
import shutil
import sqlite3
import time

import httpx
import pytest

from app import db
from app.config import db_path
from app.errors import MODEL_ONLY_THOUGHT
from app.providers import catalog, get_provider
from app.repositories import connections as connections_repo
from app.repositories import models as models_repo
from app.services import limits, turns

from .conftest import FakeProvider, assist, messages_of, send, setup_conversation, sse
from .helpers import add_model, cap
from .test_memory import EXTRACTION_JSON
from .test_memory_room import chunk, finish, thinking, writing
from .test_requests_3_7 import same_context
from .test_requests_before import (
    CALLS,
    RECORDED,
    Server,
    call_each,
    lent_to_every_provider,
    put_seed,
    without_usage_asked,
)

KEY = "sk-test-SECRET-4f2a"
OPENROUTER = "https://openrouter.ai/api/v1"
LMSTUDIO = "http://localhost:1234/v1"
OLLAMA = "http://localhost:11434/v1"
HOSTED = "https://llm.example.com/v1"
MIGRATION = "021_my_ais.sql"


class Lists:
    """The servers the catalog reads: each path answered from ``routes`` (an answer, or a function
    of the request that may wait), 404 elsewhere, and every request kept."""

    def __init__(self, routes: dict | None = None):
        self.routes = routes or {}
        self.requests: list[httpx.Request] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        answer = self.routes.get(request.url.path)
        if answer is None:
            return httpx.Response(404, json={"error": "not here"})
        if callable(answer):
            answer = answer(request)
            if asyncio.iscoroutine(answer):
                answer = await answer
        if isinstance(answer, httpx.Response):
            return answer
        return httpx.Response(200, json=answer)

    def factory(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))

    def asked(self, path: str) -> int:
        return sum(request.url.path == path for request in self.requests)


@pytest.fixture()
def lists(monkeypatch) -> Lists:
    served = Lists()
    monkeypatch.setattr(catalog, "client_factory", served.factory)
    return served


class Model:
    """A model's server for replies: each request gets the next scripted answer (SSE lines; a
    (status, body) pair is a refusal; a function makes the response), and its body is kept."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.bodies: list[dict] = []
        self.calls: list[dict] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.bodies.append(json.loads(request.content))
        answer = self.answers[min(len(self.bodies), len(self.answers)) - 1]
        if callable(answer):
            return answer()
        if isinstance(answer, tuple):
            return httpx.Response(answer[0], json=answer[1])
        return httpx.Response(200, content=sse(answer),
                              headers={"content-type": "text/event-stream"})

    def provider(self, call: dict):
        self.calls.append(call)
        provider = get_provider(call)
        provider._client_factory = lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(self.handler))
        return provider

    def serve(self, monkeypatch) -> "Model":
        for module in ("chat_service", "memory_service", "card_assistant"):
            monkeypatch.setattr(f"app.services.{module}.get_provider", self.provider)
        return self


def only_thinking() -> list[str]:
    return [chunk(reasoning_content="Let me think. " * 40), finish("length"), "[DONE]"]


def thinking_then(text: str) -> list[str]:
    return [chunk(reasoning_content="Hmm. " * 10), chunk(content=text), finish("stop"), "[DONE]"]


async def models_of(client) -> list[dict]:
    return (await client.get("/api/models")).json()


async def model_of(client, ai_id: str) -> dict:
    return next(m for m in await models_of(client) if m["id"] == ai_id)


async def services_of(client) -> list[dict]:
    return (await client.get("/api/connections")).json()


async def conversation_on(client, ai_id: str | None = None, **body) -> dict:
    character = (await client.post("/api/characters", json={
        "name": "Serana", "greeting": "*She stirs.* Hi {{user}}."})).json()
    if ai_id:
        body["model_id"] = ai_id
    resp = await client.post("/api/conversations", json={"character_id": character["id"], **body})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def add(client, service: dict, *items: dict, **body) -> httpx.Response:
    return await client.post("/api/models", json={"service": service, "models": list(items),
                                                  **body})


async def open_db():
    return await db.connect()


# A page's AIs reach their models as their connections did.


async def test_an_update_sends_each_model_the_request_it_sent_before(tmp_path, monkeypatch):
    recorded = json.loads(RECORDED.read_text(encoding="utf-8"))
    folder = tmp_path / "migrations"
    folder.mkdir()
    for path in db.MIGRATIONS_DIR.glob("*.sql"):
        if path.name < MIGRATION:
            shutil.copy(path, folder / path.name)
    real = db.MIGRATIONS_DIR
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", folder)
    await db.init_db()
    conn = sqlite3.connect(db_path())
    try:
        put_seed(conn, recorded["seed"])
        conn.commit()
    finally:
        conn.close()
    for path in real.glob("*.sql"):
        shutil.copy(path, folder / path.name)

    from app.main import create_app

    app = create_app()
    await db.init_db()  # the update
    server = Server()
    with lent_to_every_provider(server):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://localhost") as client:
            sent = await call_each(client, server)
    await limits.drain()

    assert len(server.bodies) == 20 and all(server.bodies)
    for conn_id, calls in recorded["requests"].items():
        for call in CALLS:
            # The one field 3.8.0 adds: an OpenAI-compatible server is asked for its counts.
            body = without_usage_asked(calls[call], sent[conn_id][call])
            assert (json.dumps(body, sort_keys=True)
                    == json.dumps(calls[call], sort_keys=True)), (conn_id, call)
        # The second: the wider margin of an AI that has measured nothing, and what 3.8.0 adds.
        assert same_context(calls["turn_context"], sent[conn_id]["turn_context"], 24), conn_id
    assert sent["c-openrouter"]["memory_pass"]["reasoning"] == {"effort": "none"}


async def test_a_memory_pass_keeps_the_room_it_learned_for_its_own_ai(client, monkeypatch):
    first = await add_model(client, base_url=LMSTUDIO, **cap(1024))
    second = await add_model(client, base_url="http://localhost:1235/v1", **cap(1024))
    one = await conversation_on(client, first["id"])
    other = await conversation_on(client, second["id"])
    model = Model(writing("*She smiles.*"), writing("*She smiles.*"), thinking(5120),
                  writing(EXTRACTION_JSON), writing("*She smiles again.*"),
                  writing(EXTRACTION_JSON), writing(EXTRACTION_JSON))
    model.serve(monkeypatch)
    await send(client, one["id"])
    await send(client, other["id"])

    async def extract(convo):
        resp = await client.post(f"/api/conversations/{convo['id']}/memories/extract")
        assert resp.status_code == 200, resp.text

    await extract(one)
    await send(client, one["id"], content="And then?")
    await extract(one)
    await extract(other)
    asked = [model.bodies[n].get("max_tokens") for n in (2, 3, 5, 6)]
    assert asked == [2048, 8192, 8192, 2048]


async def test_a_reply_cut_on_an_ai_that_sends_no_ceiling_names_no_number(client, monkeypatch):
    Model(writing("*She starts to", stop="length")).serve(monkeypatch)
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    assert (await messages_of(client, convo["id"]))[-1]["meta"]["ceiling"] == {"0": None}

    ai = (await models_of(client))[0]
    await client.put(f"/api/models/{ai['id']}", json=cap(1024))
    await send(client, convo["id"])
    assert (await messages_of(client, convo["id"]))[-1]["meta"]["ceiling"] == {"0": 1024}


async def test_a_failed_read_is_not_asked_again_at_every_reply(client, monkeypatch, lists,
                                                                tmp_path):
    lists.routes["/v1/models"] = httpx.Response(503, json={"error": "down"})
    ai = await add_model(client, base_url="http://mock/v1")
    convo = await conversation_on(client, ai["id"])
    Model(writing("*She nods.*")).serve(monkeypatch)
    for _ in range(3):
        await send(client, convo["id"])
        await limits.drain()
    assert lists.asked("/v1/models") == 1
    log = tmp_path / "evermind.log"
    assert not log.exists() or log.read_text(encoding="utf-8") == ""

    later = time.monotonic() + limits.FAILED_READ_KEPT_S + 1
    monkeypatch.setattr(limits, "_now", lambda: later)
    await send(client, convo["id"])
    await limits.drain()
    assert lists.asked("/v1/models") == 2


async def test_the_key_is_never_answered_logged_or_lent_to_another_address(
        client, monkeypatch, lists, caplog, tmp_path):
    caplog.set_level(logging.DEBUG)
    lists.routes["/v1/models"] = {"data": [{"id": "m1"}, {"id": "m2"}]}
    draft = {"provider": "openai-compatible", "base_url": HOSTED, "api_key": KEY}
    answers = []

    probed = await client.post("/api/connections/probe", json=draft)
    assert probed.status_code == 200, probed.text
    answers.append(probed.text)
    made = await add(client, draft, {"model": "m1"})
    assert made.status_code == 201, made.text
    answers.append(made.text)
    service = made.json()["service"]
    ai = made.json()["models"][0]
    answers += [(await client.get("/api/connections")).text, (await client.get("/api/models")).text]

    lists.routes["/v1/models"] = httpx.Response(401, json={"error": {"message": f"bad key {KEY}"}})
    refused = await client.post("/api/connections/probe", json={"id": service["id"], "fresh": True})
    assert refused.status_code == 502
    answers.append(refused.text)

    convo = await conversation_on(client, ai["id"])
    Model((401, {"error": {"message": f"key {KEY} refused"}}),
          [json.dumps({"error": {"message": f"stream broke for {KEY}"}})]).serve(monkeypatch)
    for _ in range(2):
        outcome = await send(client, convo["id"])
        assert outcome is not None
        answers.append(json.dumps(outcome))
        answers.append(json.dumps(await messages_of(client, convo["id"])))
    await limits.drain()

    for answer in answers:
        assert KEY not in answer
    assert KEY not in caplog.text
    log = tmp_path / "evermind.log"
    assert not log.exists() or KEY not in log.read_text(encoding="utf-8")

    elsewhere = {"id": service["id"], "provider": "openai-compatible", "base_url": "http://autre"}
    lists.requests.clear()
    before = (await services_of(client), await models_of(client))
    for resp in (await client.post("/api/connections/probe", json=elsewhere),
                 await client.post("/api/connections/test", json=elsewhere),
                 await add(client, elsewhere, {"model": "m2"}),
                 await client.put(f"/api/connections/{service['id']}",
                                  json={"base_url": "http://autre"})):
        assert (resp.status_code, resp.json().get("kind")) == (422, "key_needed"), resp.text
    assert (await services_of(client), await models_of(client)) == before
    assert not [r for r in lists.requests if r.url.host == "autre"]


async def test_adding_three_models_of_one_service_asks_the_key_once(client, lists):
    lists.routes["/api/v1/models"] = {"data": [{"id": f"a/{n}"} for n in range(9)]}
    lists.routes["/api/v1/key"] = {"data": {}}
    draft = {"provider": "openai-compatible", "base_url": OPENROUTER, "api_key": KEY}

    made = (await add(client, draft, {"model": "a/1"}, {"model": "a/2"}, {"model": "a/3"})).json()
    service_id = made["service"]["id"]
    assert [m["service"]["id"] for m in made["models"]] == [service_id] * 3
    assert len(await services_of(client)) == 1

    again = await add(client, {"id": service_id}, {"model": "a/4"})
    assert again.json()["service"]["id"] == service_id
    retyped = {**draft, "base_url": OPENROUTER + "/"}
    assert (await add(client, retyped, {"model": "a/5"})).json()["service"]["id"] == service_id
    assert len(await services_of(client)) == 1
    probed = (await client.post("/api/connections/probe", json=retyped)).json()
    assert probed["service_id"] == service_id

    other = (await add(client, {**draft, "api_key": "sk-other-0000"}, {"model": "a/1"})).json()
    assert other["service"]["name"] == "OpenRouter (2)"
    renewed = (await add(client, {**draft, "id": service_id, "api_key": "sk-new-9999"},
                         {"model": "a/6"})).json()
    assert renewed["service"]["id"] == service_id
    services = await services_of(client)
    assert len(services) == 2
    assert next(s for s in services if s["id"] == service_id)["api_key_hint"] == "…9999"

    twice = [(await add(client, {"id": service_id}, {"model": "a/7"})).json() for _ in range(2)]
    assert twice[0]["models"][0]["id"] == twice[1]["models"][0]["id"]
    assert sum(m["model"] == "a/7" for m in await models_of(client)) == 1


async def test_a_family_learned_by_the_probe_is_kept_at_the_add(client, lists):
    shown = []
    lists.routes.update({
        "/v1/models": {"data": [{"id": "brume:12b"}, {"id": "sylve:7b"}]},
        "/api/ps": {"models": []},
        "/api/show": lambda request: shown.append(json.loads(request.content)) or {
            "parameters": "num_ctx 16384"},
    })
    made = (await add(client, {"provider": "openai-compatible",
                               "base_url": "http://192.168.1.20:11434/v1", "family": "ollama"},
                      {"model": "brume:12b"})).json()
    assert made["service"]["family"] == "ollama"
    assert shown == [{"model": "brume:12b"}]

    hosted = (await add(client, {"provider": "openai-compatible", "base_url": OPENROUTER,
                                 "api_key": KEY}, {"model": "a/1"})).json()
    await add(client, {"id": hosted["service"]["id"], "family": "ollama"}, {"model": "a/2"})
    service = next(s for s in await services_of(client) if s["id"] == hosted["service"]["id"])
    assert service["family"] == "openrouter"


async def test_a_price_sent_back_by_the_page_is_stored_as_it_was_read(client):
    made = (await add(client, {"provider": "openai-compatible", "base_url": OPENROUTER,
                               "api_key": KEY},
                      {"model": "a/1", "read": {"id": "a/1", "name": "One",
                                                "context": {"served": "lots"},
                                                "price": {"input": 3.0, "output": 15.0}}})).json()
    ai = made["models"][0]
    assert (ai["price"]["read_in"], ai["price"]["read_out"]) == (3.0, 15.0)
    assert ai["context"]["read"] is None
    assert ai["limits_read_at"] is not None


async def test_a_local_gateway_is_not_called_free(client):
    gateway = await add_model(client, base_url="http://127.0.0.1:4000/v1", as_added=True)
    lmstudio = await add_model(client, base_url=LMSTUDIO, as_added=True)
    rented = await add_model(client, base_url="https://gpu.example.com/v1", family="llamacpp",
                             as_added=True)
    priced = await add_model(client, base_url="http://127.0.0.1:4001/v1", as_added=True,
                             price_own_in=0, price_own_out=0)
    assert [gateway["free"], lmstudio["free"], rented["free"], priced["free"]] == [
        False, True, False, True]


async def test_an_ai_read_as_reasoning_is_left_its_own_settings(client):
    made = (await add(client, {"provider": "openai-compatible", "base_url": HOSTED},
                      {"model": "ponder", "read": {"id": "ponder", "reasons": True}},
                      {"model": "plain", "read": {"id": "plain", "reasons": False}})).json()
    settings = ("temperature", "top_p", "frequency_penalty", "presence_penalty")
    ponder, plain = made["models"]
    assert [ponder[key] for key in settings] == [None, None, None, None]
    assert [plain[key] for key in settings] == [0.8, 0.95, 0.15, 0.15]


async def test_a_name_already_taken_is_followed_by_its_service(client):
    first = (await add(client, {"provider": "openai-compatible", "base_url": HOSTED,
                                "name": "Home"}, {"model": "a/brume", "name": "Brume"})).json()
    second = (await add(client, {"provider": "openai-compatible", "base_url": OPENROUTER,
                                 "api_key": KEY, "name": "Rented"},
                        {"model": "b/brume", "name": "Brume"})).json()
    assert first["models"][0]["name"] == "Brume"
    assert second["models"][0]["name"] == "Brume (Rented)"


async def test_an_ollama_model_reads_its_size_when_added(client, lists, monkeypatch):
    shown = []
    lists.routes.update({
        "/v1/models": {"data": [{"id": "brume:12b"}, {"id": "sylve:7b"}]},
        "/api/ps": {"models": []},
        "/api/show": lambda request: shown.append(json.loads(request.content)) or {
            "parameters": "temperature 0.7\nnum_ctx 16384"},
    })
    made = (await add(client, {"provider": "openai-compatible", "base_url": OLLAMA},
                      {"model": "brume:12b"})).json()["models"][0]
    assert shown == [{"model": "brume:12b"}]
    assert (made["context"]["read"], made["context"]["read_kind"]) == (16384, "configured")

    def off(request):
        raise httpx.ConnectError("off", request=request)

    monkeypatch.setattr(catalog, "client_factory",
                        lambda: httpx.AsyncClient(transport=httpx.MockTransport(off)))
    catalog._cache.clear()
    started = time.monotonic()
    typed = await add(client, {"provider": "openai-compatible", "base_url": OLLAMA},
                      {"model": "typed:3b"})
    assert typed.status_code == 201, typed.text
    assert time.monotonic() - started < 3
    ai = typed.json()["models"][0]
    assert ai["context"]["read"] is None
    assert ai["context"]["used"] == 4096


async def test_a_local_server_that_never_answers_does_not_hold_the_add(client, lists):
    never = asyncio.Event()

    async def silent(_):
        await never.wait()

    lists.routes.update({"/v1/models": silent, "/api/ps": silent, "/api/show": silent})
    started = time.monotonic()
    made = await asyncio.wait_for(add(client, {"provider": "openai-compatible",
                                               "base_url": OLLAMA}, {"model": "brume:12b"}), 10)
    assert made.status_code == 201, made.text
    assert time.monotonic() - started < 3
    ai = made.json()["models"][0]
    assert ai["context"]["read"] is None
    assert ai["context"]["used"] == 4096


async def test_adding_from_a_conversation_sets_its_ai_or_writes_nothing(client):
    convo = await setup_conversation(client)
    made = (await add(client, {"provider": "openai-compatible", "base_url": HOSTED},
                      {"model": "a"}, {"model": "b"}, conversation_id=convo["id"])).json()
    last = made["models"][-1]["id"]
    assert made["conversation"]["model_id"] == last
    got = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert got["model_id"] == last

    await client.delete(f"/api/conversations/{convo['id']}")
    before = (await services_of(client), await models_of(client))
    gone = await add(client, {"provider": "openai-compatible", "base_url": "http://other/v1"},
                     {"model": "c"}, conversation_id=convo["id"])
    assert gone.status_code == 404
    assert (gone.json()["kind"], gone.json()["resource"]) == ("not_found", "conversation")
    assert (await services_of(client), await models_of(client)) == before


async def test_a_failed_or_poorer_read_keeps_what_was_read_before(client, lists):
    ai = await add_model(client, base_url=HOSTED, model="m",
                         read={"id": "m", "context": {"served": 32768}})
    assert ai["context"]["read"] == 32768

    async def refresh():
        resp = await client.post(f"/api/models/{ai['id']}/refresh", json={"fresh": True})
        assert resp.status_code == 200, resp.text
        return resp.json()

    off = await refresh()
    assert off["read_ok"] is False and off["error"]["kind"]
    assert off["model"]["context"]["read"] == 32768
    lists.routes["/v1/models"] = {"data": [{"id": "m", "meta": {"n_ctx_train": 131072}}]}
    poorer = await refresh()
    assert poorer["read_ok"] is True
    assert poorer["model"]["context"]["read"] == 32768
    lists.routes["/v1/models"] = {"data": [{"id": "m", "context_length": 8192}]}
    assert (await refresh())["model"]["context"]["read"] == 8192


async def test_a_typed_value_above_what_the_server_says_is_kept_with_a_warning(client):
    ai = await add_model(client, base_url=HOSTED, read={"id": "mock", "context": {"served": 32768}},
                         as_added=True)
    url = f"/api/models/{ai['id']}"

    above = await client.put(url, json={"context_own": 65536})
    assert above.status_code == 200
    assert above.json()["warnings"] == ["above_read_window"]
    for kept in (300_000_000, 2**53 - 1):
        assert (await client.put(url, json={"context_own": kept})).status_code == 200
    for refused in ({"context_own": 2**53}, {"context_own": 1e20}, {"context_own": 511},
                    {"price_own_in": -1}):
        assert (await client.put(url, json=refused)).status_code == 422, refused

    await client.put(url, json={"context_own": 16384})
    close = (await client.put(url, json=cap(16000))).json()
    assert "cap_above_window" in close["warnings"]
    fits = (await client.put(url, json=cap(15000))).json()
    assert "cap_above_window" not in fits["warnings"]


async def test_changing_the_model_id_forgets_what_was_read_for_the_old_one(
        client, lists, monkeypatch):
    ai = await add_model(client, base_url=HOSTED, model="m", as_added=True, read={
        "id": "m", "context": {"served": 200000}, "reasons": True,
        "price": {"input": 3.0, "output": 15.0}})
    url = f"/api/models/{ai['id']}"
    await client.put(url, json={"context_own": 32768})
    lists.requests.clear()

    changed = (await client.put(url, json={"model": "autre"})).json()
    assert changed["context"]["read"] is None and changed["reasons"] is None
    assert (changed["price"]["read_in"], changed["price"]["read_out"]) == (None, None)
    assert changed["limits_read_at"] is None
    assert changed["context"]["own"] == 32768
    await limits.drain()
    assert lists.asked("/v1/models") == 1

    model = Model(writing("*She nods.*")).serve(monkeypatch)
    convo = await conversation_on(client, ai["id"])
    await send(client, convo["id"])
    assert model.bodies[-1]["model"] == "autre"
    assert model.bodies[-1]["max_tokens"] == 1024


async def test_a_read_for_the_old_model_id_is_not_stored_on_the_new_one(client, lists):
    asked, release = asyncio.Event(), asyncio.Event()

    async def held(_):
        asked.set()
        await release.wait()
        return {"data": [{"id": "m", "context_length": 200000,
                          "reasoning": {"mandatory": True}}]}

    lists.routes.update({"/api/v1/models": held, "/api/v1/key": {"data": {}}})
    ai = await add_model(client, base_url=OPENROUTER, model="m", api_key=KEY, as_added=True)
    reading = asyncio.create_task(
        client.post(f"/api/models/{ai['id']}/refresh", json={"fresh": True}))
    await asyncio.wait_for(asked.wait(), 5)
    assert (await client.put(f"/api/models/{ai['id']}", json={"model": "autre"})).status_code == 200
    release.set()
    assert (await reading).status_code == 200

    after = await model_of(client, ai["id"])
    assert (after["model"], after["context"]["read"], after["reasons"]) == ("autre", None, None)
    conn = await open_db()
    try:
        await models_repo.learn_reasons(conn, ai["id"], "m")
    finally:
        await conn.close()
    assert (await model_of(client, ai["id"]))["reasons"] is None


async def test_a_service_moved_to_another_address_has_its_ais_read_again(client):
    ai = await add_model(client, base_url=HOSTED, model="m", as_added=True,
                         read={"id": "m", "context": {"served": 200000}})
    service_id = ai["service"]["id"]
    read_at = ai["limits_read_at"]
    assert read_at is not None

    renamed = await client.put(f"/api/connections/{service_id}",
                               json={"name": "Elsewhere", "base_url": HOSTED + "/"})
    assert renamed.status_code == 200, renamed.text
    assert (await model_of(client, ai["id"]))["limits_read_at"] == read_at

    moved = await client.put(f"/api/connections/{service_id}",
                             json={"base_url": "https://moved.example.com/v1"})
    assert moved.status_code == 200, moved.text
    after = await model_of(client, ai["id"])
    assert after["limits_read_at"] is None
    assert after["context"]["read"] == 200000


async def test_a_read_from_the_old_address_is_not_stored_after_a_move(client, lists):
    asked, release = asyncio.Event(), asyncio.Event()

    async def held(_):
        asked.set()
        await release.wait()
        return {"data": [{"id": "m", "context_length": 200000}]}

    lists.routes["/v1/models"] = held
    ai = await add_model(client, base_url=HOSTED, model="m", as_added=True)
    reading = asyncio.create_task(
        client.post(f"/api/models/{ai['id']}/refresh", json={"fresh": True}))
    await asyncio.wait_for(asked.wait(), 5)
    moved = await client.put(f"/api/connections/{ai['service']['id']}",
                             json={"base_url": "https://moved.example.com/v1"})
    assert moved.status_code == 200, moved.text
    release.set()
    assert (await reading).status_code == 200

    after = await model_of(client, ai["id"])
    assert (after["context"]["read"], after["limits_read_at"]) == (None, None)


async def test_adding_to_a_service_removed_meanwhile_is_not_found_and_writes_nothing(
        client, lists):
    lists.routes.update({"/v1/models": {"data": [{"id": "brume:12b"}, {"id": "sylve:7b"}]},
                         "/api/ps": {"models": []}})
    first = (await add(client, {"provider": "openai-compatible", "base_url": OLLAMA},
                       {"model": "brume:12b"})).json()["models"][0]
    asked, release = asyncio.Event(), asyncio.Event()

    async def held(_):
        asked.set()
        await release.wait()
        return {"parameters": "num_ctx 16384"}

    lists.routes["/api/show"] = held
    adding = asyncio.create_task(add(client, {"id": first["service"]["id"]},
                                     {"model": "sylve:7b"}))
    await asyncio.wait_for(asked.wait(), 5)
    assert (await client.delete(f"/api/models/{first['id']}")).status_code == 204
    release.set()
    gone = await adding

    assert gone.status_code == 404, gone.text
    assert (gone.json()["kind"], gone.json()["resource"]) == ("not_found", "connection")
    assert (await services_of(client), await models_of(client)) == ([], [])


async def test_a_turn_refused_for_credit_says_so(client, monkeypatch):
    Model((402, {"error": {"message": "Insufficient credits"}})).serve(monkeypatch)
    convo = await setup_conversation(client)
    outcome = await send(client, convo["id"])
    assert outcome["kind"] == "model_no_credit"


async def test_an_ai_removed_while_it_replies_finishes_and_the_conversation_says_so(
        client, monkeypatch):
    default = await add_model(client, base_url=LMSTUDIO, model="kept", name="Brume")
    leaving = await add_model(client, base_url=HOSTED, model="leaving", name="Sylve")
    convo = await conversation_on(client, leaving["id"])
    words = [f"word{n}" for n in range(8)]

    async def slowly():
        for word in words:
            await asyncio.sleep(0.05)
            yield f"data: {chunk(content=word + ' ')}\n\n".encode()
        yield f"data: {finish('stop')}\n\ndata: [DONE]\n\n".encode()

    Model(lambda: httpx.Response(200, content=slowly(),
                                 headers={"content-type": "text/event-stream"})).serve(monkeypatch)
    resp = await client.post("/api/chat", json={"conversation_id": convo["id"], "mode": "send",
                                                "content": "Hello"})
    assert resp.status_code == 200
    turn = await turns.running_for(convo["id"])
    while not turn.text:
        await asyncio.sleep(0.01)
    assert (await client.delete(f"/api/models/{leaving['id']}")).status_code == 204
    await turn.finished.wait()
    await limits.drain()

    assert (await messages_of(client, convo["id"]))[-1]["content"] == " ".join(words)
    after = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert (after["model_id"], after["model_lost"]) == (default["id"], "Sylve")

    newer = await add_model(client, base_url=HOSTED, model="newer", is_default=True)
    assert (await model_of(client, newer["id"]))["is_default"] is True
    after = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert after["model_id"] == default["id"]

    conn = await open_db()
    try:
        await models_repo.learn_reasons(conn, leaving["id"], "leaving")
    finally:
        await conn.close()
    limits.schedule_refresh(leaving["id"], fresh=False)
    await limits.drain()


async def test_removing_the_last_ai_of_a_service_forgets_its_key(client):
    ai = await add_model(client, base_url=HOSTED, api_key=KEY)
    assert (await client.delete(f"/api/models/{ai['id']}")).status_code == 204
    assert await services_of(client) == []
    conn = sqlite3.connect(db_path())
    try:
        assert conn.execute("SELECT COUNT(*) FROM connections WHERE api_key = ?",
                            (KEY,)).fetchone()[0] == 0
    finally:
        conn.close()


async def test_a_new_conversation_keeps_the_default_of_its_creation(client):
    first = await add_model(client, base_url=LMSTUDIO, model="first")
    second = await add_model(client, base_url=LMSTUDIO, model="second")
    convo = await conversation_on(client)
    assert convo["model_id"] == first["id"]
    await client.put(f"/api/models/{second['id']}", json={"is_default": True})
    got = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert got["model_id"] == first["id"]


async def test_a_page_from_before_the_update_still_picks_a_model(client, monkeypatch):
    at = "2026-01-01T00:00:00+00:00"
    conn = sqlite3.connect(db_path())
    try:
        conn.execute("INSERT INTO connections (id, name, provider, base_url, created_at,"
                     " updated_at) VALUES ('c1', 'LM Studio', 'openai-compatible', ?, ?, ?)",
                     (LMSTUDIO, at, at))
        for ai_id, model in (("c1", "brume"), ("c1b", "sylve")):
            conn.execute("INSERT INTO models (id, connection_id, model, name, migrated,"
                         " created_at, updated_at) VALUES (?, 'c1', ?, ?, 1, ?, ?)",
                         (ai_id, model, model, at, at))
        conn.commit()
    finally:
        conn.close()
    made = (await add(client, {"provider": "openai-compatible", "base_url": HOSTED},
                      {"model": "x"}, {"model": "y"})).json()
    service, (_, y) = made["service"], made["models"]
    await client.put(f"/api/models/{y['id']}", json={"is_default": True})

    convo = await conversation_on(client)
    for sent, picked in (("c1", "c1"), (service["id"], y["id"])):
        patched = await client.patch(f"/api/conversations/{convo['id']}",
                                     json={"connection_id": sent})
        assert patched.json()["model_id"] == picked
        assert (await conversation_on(client, connection_id=sent))["model_id"] == picked
    unknown = await client.patch(f"/api/conversations/{convo['id']}",
                                 json={"connection_id": "gone"})
    assert (unknown.status_code, unknown.json()["resource"]) == (404, "model")
    assert (await conversation_on(client, connection_id="gone"))["model_id"] == y["id"]

    monkeypatch.setattr("app.services.card_assistant.get_provider", FakeProvider)
    FakeProvider.script = []
    for sent, picked in (("c1", "c1"), ("gone", y["id"])):
        await assist(client, connection_id=sent)
        assert FakeProvider.captured["connection"]["model_id"] == picked


async def test_a_page_from_before_the_update_cannot_remove_or_half_save_ais(client):
    made = (await add(client, {"provider": "openai-compatible", "base_url": HOSTED,
                               "api_key": KEY}, {"model": "a"}, {"model": "b"})).json()
    service = made["service"]
    refused = await client.delete(f"/api/connections/{service['id']}")
    assert (refused.status_code, refused.json()["kind"]) == (409, "service_in_use")
    assert "reload" in refused.json()["error"]
    assert len(await models_of(client)) == 2
    assert (await services_of(client))[0]["api_key_set"] is True

    whole = await client.put(f"/api/connections/{service['id']}", json={
        "name": "Renamed", "provider": "openai-compatible", "base_url": HOSTED, "model": "a",
        "context_size": 8192, "max_tokens": None, "is_default": True})
    assert (whole.status_code, whole.json()["kind"]) == (422, "page_outdated")
    assert "reload" in whole.json()["error"]
    assert (await services_of(client))[0]["name"] == service["name"]
    for route in ("/api/connections", "/api/connections/benchmark"):
        gone = await client.post(route, json={"name": "Old", "base_url": HOSTED, "model": "a"})
        assert (gone.status_code, gone.json()["kind"]) == (410, "page_outdated")
        assert "reload" in gone.json()["error"]
    assert len(await services_of(client)) == 1

    conn = sqlite3.connect(db_path())
    try:
        at = "2026-01-01T00:00:00+00:00"
        conn.execute("INSERT INTO connections (id, name, provider, base_url, created_at,"
                     " updated_at) VALUES ('bare', 'Spare', 'openai-compatible', ?, ?, ?)",
                     (HOSTED, at, at))
        conn.commit()
    finally:
        conn.close()
    assert (await client.delete("/api/connections/bare")).status_code == 204


async def test_reasoning_learned_from_a_reply_lifts_the_ceiling_next_time(
        client, lists, monkeypatch):
    lists.routes.update({"/api/v1/models": {"data": [{"id": "a/think", "reasoning": {
        "mandatory": False, "default_enabled": False}}]}, "/api/v1/key": {"data": {}}})
    ai = await add_model(client, base_url=OPENROUTER, model="a/think", api_key=KEY, as_added=True)
    convo = await conversation_on(client, ai["id"])
    model = Model(thinking_then("*She answers.*")).serve(monkeypatch)
    await send(client, convo["id"])
    await limits.drain()
    assert model.bodies[0]["max_tokens"] == 1024
    assert (await model_of(client, ai["id"]))["reasons"] is True

    read = await client.post(f"/api/models/{ai['id']}/refresh", json={"fresh": True})
    assert read.json()["read_ok"] is True
    assert (await model_of(client, ai["id"]))["reasons"] is True
    await send(client, convo["id"])
    assert "max_tokens" not in model.bodies[-1]


async def test_a_reply_that_only_thinks_still_teaches_that_the_model_reasons(client, monkeypatch):
    ai = await add_model(client, base_url=HOSTED, model="ponder", as_added=True)
    convo = await conversation_on(client, ai["id"])
    model = Model(only_thinking()).serve(monkeypatch)
    outcome = await send(client, convo["id"])
    assert outcome["kind"] == MODEL_ONLY_THOUGHT
    assert len(model.bodies) == 1
    assert (await model_of(client, ai["id"]))["reasons"] is True
    model.answers = [writing("*She speaks.*")]
    await send(client, convo["id"])
    assert "max_tokens" not in model.bodies[-1]

    pen = await add_model(client, base_url=HOSTED, model="pen", as_added=True)
    await client.patch(f"/api/conversations/{convo['id']}", json={"model_id": pen["id"]})
    model.answers = [only_thinking()]
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert (resp.status_code, resp.json()["kind"]) == (502, MODEL_ONLY_THOUGHT)
    assert (await model_of(client, pen["id"]))["reasons"] is True
    model.answers = [writing("I take her hand.")]
    assert (await client.post(f"/api/conversations/{convo['id']}/impersonate")).status_code == 200
    assert "max_tokens" not in model.bodies[-1]

    await client.delete(f"/api/models/{pen['id']}")
    conn = await open_db()
    try:
        await models_repo.learn_reasons(conn, pen["id"], "pen")
    finally:
        await conn.close()


async def test_the_card_assistant_learns_that_a_model_thinks(client, monkeypatch):
    ai = await add_model(client, base_url=HOSTED, model="ponder", as_added=True)
    model = Model(only_thinking()).serve(monkeypatch)
    state = await assist(client, model_id=ai["id"])
    assert state["error"]["kind"] == MODEL_ONLY_THOUGHT
    assert model.bodies[0]["max_tokens"] > 0
    assert (await model_of(client, ai["id"]))["reasons"] is True
    model.answers = [writing(json.dumps({"name": "Mira", "description": "A pirate."}))]
    await assist(client, model_id=ai["id"])
    assert "max_tokens" not in model.bodies[-1]


@pytest.mark.parametrize("route", ["extract", "consolidate"])
async def test_a_memory_pass_that_thinks_teaches_that_the_model_reasons(client, monkeypatch,
                                                                        route):
    ai = await add_model(client, base_url=HOSTED, model="ponder", as_added=True)
    convo = await conversation_on(client, ai["id"])
    model = Model(writing("*She nods.*")).serve(monkeypatch)
    await send(client, convo["id"])
    assert model.bodies[-1]["max_tokens"] > 0
    url = f"/api/conversations/{convo['id']}/memories"
    for n in range(8):
        await client.post(url, json={"content": f"Fact number {n}."})
    conn = await open_db()
    try:
        await conn.execute("UPDATE memories SET source = 'auto'")
        await conn.commit()
    finally:
        await conn.close()

    # It thought, then wrote what is not JSON: the pass fails, and still learns.
    model.answers = [thinking_then("Not a memory at all.")]
    failed = await client.post(f"{url}/{route}")
    assert (failed.status_code, failed.json()["kind"]) == (502, "model_unreadable")
    assert (await model_of(client, ai["id"]))["reasons"] is True
    model.answers = [writing("*She speaks.*")]
    await send(client, convo["id"])
    assert "max_tokens" not in model.bodies[-1]


async def test_a_local_model_is_read_again_after_its_first_reply(client, lists, monkeypatch):
    native = {"models": [{"key": "brume", "type": "llm", "max_context_length": 131072}]}
    lists.routes.update({"/v1/models": {"data": [{"id": "brume"}]}, "/api/v1/models": native})
    ai = await add_model(client, base_url=LMSTUDIO, model="brume", as_added=True)
    assert (ai["context"]["read"], ai["context"]["read_kind"]) == (131072, "max")
    assert ai["context"]["used"] == 4096

    native["models"][0]["loaded_instances"] = [{"config": {"context_length": 32768}}]
    convo = await conversation_on(client, ai["id"])
    Model(writing("*She nods.*")).serve(monkeypatch)
    lists.requests.clear()
    await send(client, convo["id"])
    await limits.drain()
    assert lists.asked("/v1/models") == 1
    after = await model_of(client, ai["id"])
    assert (after["context"]["read"], after["context"]["read_kind"]) == (32768, "served")
    assert after["context"]["used"] == 32768

    await send(client, convo["id"])
    await limits.drain()
    assert lists.asked("/v1/models") == 1


async def test_a_local_model_that_never_says_its_size_is_read_once_after_a_reply(
        client, lists, monkeypatch):
    # LM Studio with the model not loaded: only its largest size, never what it serves.
    lists.routes.update({"/v1/models": {"data": [{"id": "brume"}]}, "/api/v1/models": {
        "models": [{"key": "brume", "type": "llm", "max_context_length": 131072}]}})
    ai = await add_model(client, base_url=LMSTUDIO, model="brume", as_added=True)
    convo = await conversation_on(client, ai["id"])
    Model(writing("*She nods.*")).serve(monkeypatch)
    lists.requests.clear()
    for _ in range(2):
        await send(client, convo["id"])
        await limits.drain()
    assert lists.asked("/v1/models") == 1
    assert (await model_of(client, ai["id"]))["context"]["read_kind"] == "max"


async def test_a_hosted_ai_read_after_its_first_reply_uses_the_cached_list(
        client, lists, monkeypatch):
    lists.routes.update({"/api/v1/models": {"data": [{"id": "a/one", "context_length": 64000},
                                                     {"id": "a/two", "context_length": 32000}]},
                         "/api/v1/key": {"data": {}}})
    made = (await add(client, {"provider": "openai-compatible", "base_url": OPENROUTER,
                               "api_key": KEY}, {"model": "a/one"}, {"model": "a/two"})).json()
    probed = await client.post("/api/connections/probe", json={"id": made["service"]["id"]})
    assert probed.status_code == 200
    Model(writing("*She nods.*")).serve(monkeypatch)
    for ai in made["models"]:
        convo = await conversation_on(client, ai["id"])
        await send(client, convo["id"])
    await limits.drain()
    # One read of the list: its first page, as the probe asked for it.
    assert [r.url.params.get("offset") for r in lists.requests
            if r.url.path == "/api/v1/models"].count("0") == 1
    assert [(await model_of(client, ai["id"]))["context"]["read"]
            for ai in made["models"]] == [64000, 32000]


async def test_a_service_s_family_follows_its_address(client, lists):
    at = "2026-01-01T00:00:00+00:00"
    conn = sqlite3.connect(db_path())
    try:
        for row in (("s1", "https://openrouter.ai/api/v1/", "generic", None),
                    ("s2", "http://192.168.1.20:8000/v1", "generic", None),
                    ("s3", "http://192.168.1.20:1234/v1", "openrouter", OPENROUTER),
                    ("s4", "http://192.168.1.21:1234/v1", "lmstudio",
                     "http://192.168.1.21:1234/v1")):
            conn.execute("INSERT INTO connections (id, name, provider, base_url, family,"
                         " family_url, api_key, created_at, updated_at)"
                         " VALUES (?, ?, 'openai-compatible', ?, ?, ?, 'sk-old', ?, ?)",
                         (row[0], row[0], row[1], row[2], row[3], at, at))
        conn.commit()
    finally:
        conn.close()
    conn = await open_db()
    try:
        await connections_repo.name_families(conn)
    finally:
        await conn.close()
    families = {s["id"]: s["family"] for s in await services_of(client)}
    assert families == {"s1": "openrouter", "s2": "generic", "s3": "generic", "s4": "lmstudio"}

    lists.routes["/v1/models"] = {"data": [{"id": "m"}]}
    await client.post("/api/connections/probe", json={"id": "s3"})
    assert not [r for r in lists.requests if r.url.path.endswith("/key")]

    moved = await client.put("/api/connections/s4", json={
        "base_url": "http://192.168.1.22:1234/v1", "api_key": "sk-old"})
    assert moved.json()["family"] == "generic"
    keyless = await client.put("/api/connections/s2", json={
        "base_url": "http://192.168.1.23:8000/v1", "api_key": ""})
    assert keyless.status_code == 200
    assert keyless.json()["api_key_set"] is False


async def test_the_successor_of_a_removed_ai(client):
    first = await add_model(client, base_url=LMSTUDIO, model="first", name="Brume")
    second = await add_model(client, base_url=LMSTUDIO, model="second")
    third = await add_model(client, base_url=LMSTUDIO, model="third")
    conn = await open_db()
    try:
        assert (await models_repo.successor(conn, second["id"]))["id"] == first["id"]
        assert (await models_repo.successor(conn, first["id"]))["id"] == second["id"]
        for ai in (second, third):
            await client.delete(f"/api/models/{ai['id']}")
        assert await models_repo.successor(conn, first["id"]) is None
    finally:
        await conn.close()
    convo = await conversation_on(client, first["id"])
    await client.delete(f"/api/models/{first['id']}")
    after = (await client.get(f"/api/conversations/{convo['id']}")).json()
    assert (after["model_id"], after["model_lost"]) == (None, "Brume")


async def test_the_old_test_route_answers_as_before(client, monkeypatch):
    listed = Lists({"/v1/models": {"data": [{"id": f"m{n}"} for n in range(10)]}})

    def provider(service):
        made = get_provider(service)
        made._client_factory = listed.factory
        return made

    monkeypatch.setattr("app.routers.connections.get_provider", provider)
    body = (await client.post("/api/connections/test", json={
        "name": "Old", "provider": "openai-compatible", "base_url": HOSTED, "model": "m0",
        "context_size": 8192, "max_tokens": None})).json()
    assert body == {"ok": True, "detail": "10 models available", "model_count": 10,
                    "models_sample": [f"m{n}" for n in range(8)]}


async def test_the_list_is_served_compressed(client, lists):
    fixture = json.loads((catalog_fixtures() / "openrouter_471.json").read_text(encoding="utf-8"))
    lists.routes.update({"/api/v1/models": fixture, "/api/v1/key": {"data": {}}})
    resp = await client.post("/api/connections/probe", json={
        "provider": "openai-compatible", "base_url": OPENROUTER, "api_key": KEY},
        headers={"Accept-Encoding": "gzip"})
    assert resp.status_code == 200
    assert resp.headers["content-encoding"] == "gzip"
    assert len(resp.json()["models"]) == 384
    assert resp.num_bytes_downloaded < 15_000


def catalog_fixtures():
    from pathlib import Path

    return Path(__file__).parent / "fixtures" / "catalog"


async def test_shutdown_does_not_wait_for_a_stuck_read(client, lists):
    never = asyncio.Event()

    async def stuck(_):
        await never.wait()

    lists.routes["/v1/models"] = stuck
    ai = await add_model(client, base_url=HOSTED, model="m")
    limits.schedule_refresh(ai["id"], fresh=True)
    await asyncio.sleep(0.05)
    started = time.monotonic()
    await limits.drain(cancel=True)
    assert time.monotonic() - started < 1
    assert (await model_of(client, ai["id"]))["limits_read_at"] is None
