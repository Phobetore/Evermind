"""What Evermind reads of each family of servers: every model a server lists, how much each reads
at once, how long a reply may be, its price and whether it reasons first. A server that answers
badly, slowly or not at all never breaks the read, and no test here reaches a real address."""

import asyncio
import copy
import gzip
import json
import math
import time
from pathlib import Path

import httpx
import pytest

from app.providers import catalog, complete_answer
from app.providers.base import (
    AUTH_REFUSED,
    LIST_TIMEOUT,
    UNREACHABLE,
    ProviderError,
)
from app.providers.catalog import (
    Catalog,
    Listed,
    amount,
    display_name,
    dropped,
    family_of,
    is_local,
    is_loopback,
    per_million,
    read_catalog,
    read_one,
    relayed,
    service_name,
    whole,
)
from app.providers.openai_compat import OpenAICompatProvider, least_reasoning

from .conftest import PAYLOAD, anth_provider, collect, oai_provider, sse

FIXTURES = Path(__file__).parent / "fixtures" / "catalog"
OPENROUTER = "https://openrouter.ai/api/v1"
KEY = "sk-test-SECRET-4f2a"
MINUTES = 60.0
HOURS = 3600.0


def fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def service(base_url: str = "http://192.168.1.20:5000/v1", provider: str = "openai-compatible",
            **fields) -> dict:
    return {"provider": provider, "base_url": base_url, "api_key": KEY, **fields}


class Server:
    """Answers each path from ``routes`` (a response, or a function of the request), 404
    elsewhere, and keeps every request it was sent."""

    def __init__(self, routes: dict):
        self.routes = routes
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
        # Escaped as a server writes it: half an emoji travels as "\ud83d".
        return httpx.Response(200, content=json.dumps(answer).encode(),
                              headers={"content-type": "application/json"})

    def factory(self):
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))

    def paths(self) -> list[str]:
        return [request.url.path for request in self.requests]

    async def read(self, svc: dict, **options) -> Catalog:
        # Each read here is the one under test, never one kept by the read before it.
        options.setdefault("fresh", True)
        return await read_catalog(svc, client_factory=self.factory, **options)


def by_id(read: Catalog) -> dict[str, Listed]:
    return {m.id: m for m in read.models}


def openrouter_entry(model_id: str, **fields) -> dict:
    return {"id": model_id, "name": f"Brume: {model_id}", **fields}


OPENROUTER_KEY_OK = {"data": {"label": "sk-...4f2a", "limit": None}}


# OpenRouter


async def test_openrouter_gives_window_output_price_name_and_reasoning():
    entries = [
        openrouter_entry(
            "aurore/aurore-large", name="Aurore: Aurore Large", created=1794614400,
            context_length=131072, top_provider={"max_completion_tokens": 16384},
            pricing={"prompt": "0.000003", "completion": "0.000015",
                     "input_cache_read": "0.0000003", "input_cache_write": "0.00000375"},
            reasoning={"mandatory": False, "default_enabled": True}),
        openrouter_entry("a/mandatory", reasoning={"mandatory": True}),
        openrouter_entry("a/off", reasoning={"mandatory": False, "default_enabled": False}),
        openrouter_entry("a/untold", reasoning={"mandatory": False}),
        openrouter_entry("a/plain", supported_parameters=["temperature"]),
        openrouter_entry("a/asks", supported_parameters=["temperature", "include_reasoning"]),
        openrouter_entry("a/free", pricing={"prompt": "0", "completion": "0"}),
        openrouter_entry("routeur/auto", pricing={"prompt": "-1", "completion": "-1"}),
    ]
    server = Server({"/api/v1/models": {"data": entries}, "/api/v1/key": OPENROUTER_KEY_OK})
    read = await server.read(service(OPENROUTER))
    models = by_id(read)
    assert read.family == "openrouter"

    large = models["aurore/aurore-large"]
    assert (large.price_in, large.price_out) == (3.0, 15.0)
    assert (large.price_cache_read, large.price_cache_write) == (0.3, 3.75)
    assert (large.served, large.max_output, large.created) == (131072, 16384, 1794614400)
    assert (large.name, large.vendor) == ("Aurore: Aurore Large", "Aurore")
    assert display_name(large, "openrouter") == "Aurore Large"
    assert large.reasons is True and large.price_varies is False

    assert models["a/mandatory"].reasons is True
    assert models["a/off"].reasons is False
    assert models["a/untold"].reasons is None
    assert models["a/plain"].reasons is False
    assert models["a/asks"].reasons is None
    assert (models["a/free"].price_in, models["a/free"].price_out) == (0.0, 0.0)
    router = models["routeur/auto"]
    assert (router.price_in, router.price_out, router.price_varies) == (None, None, True)


def pages_by_offset(total: int, size: int, ignores_offset: bool = False):
    def answer(request: httpx.Request):
        offset = 0 if ignores_offset else int(request.url.params.get("offset", 0))
        ids = [f"v/m{n}" for n in range(offset, min(offset + size, total))]
        return {"data": [{"id": i} for i in ids]}

    return answer


@pytest.mark.parametrize(("size", "ignores_offset", "count", "lists"), [
    pytest.param(1000, False, 2012, 4, id="pages of a thousand"),
    pytest.param(500, False, 2012, 6, id="a server that ignores the limit"),
    pytest.param(1000, True, 1000, 2, id="a server that ignores the offset"),
])
async def test_openrouter_reads_past_its_default_page(size, ignores_offset, count, lists):
    server = Server({"/api/v1/models": pages_by_offset(2012, size, ignores_offset),
                     "/api/v1/key": OPENROUTER_KEY_OK})
    read = await server.read(service(OPENROUTER))
    assert len(read.models) == count
    assert server.paths().count("/api/v1/models") == lists
    first = next(r for r in server.requests if r.url.path.endswith("/models"))
    assert (first.url.params["limit"], first.url.params["offset"]) == ("1000", "0")


async def test_openrouter_reads_its_list_without_parameters_when_they_are_refused():
    def answer(request: httpx.Request):
        if request.url.params:
            return httpx.Response(400, json={"error": {"message": "unknown parameter"}})
        return {"data": [{"id": "v/a"}, {"id": "v/b"}]}

    server = Server({"/api/v1/models": answer, "/api/v1/key": OPENROUTER_KEY_OK})
    read = await server.read(service(OPENROUTER))
    assert [m.id for m in read.models] == ["v/a", "v/b"]


async def test_openrouter_follows_its_links_from_the_origin_and_only_there():
    def answer(request: httpx.Request):
        if request.url.params.get("offset") == "2":
            return {"data": [{"id": "v/c"}], "links": {"next": None}}
        return {"data": [{"id": "v/a"}, {"id": "v/b"}],
                "links": {"next": "/api/v1/models?offset=2&limit=2"}}

    server = Server({"/api/v1/models": answer, "/api/v1/key": OPENROUTER_KEY_OK})
    read = await server.read(service(OPENROUTER))
    assert [m.id for m in read.models] == ["v/a", "v/b", "v/c"]
    lists = [str(r.url) for r in server.requests if r.url.path.endswith("/models")]
    assert lists[1] == "https://openrouter.ai/api/v1/models?offset=2&limit=2"

    def elsewhere(_: httpx.Request):
        return {"data": [{"id": "v/a"}], "links": {"next": "https://autre.example/models"}}

    server = Server({"/api/v1/models": elsewhere, "/api/v1/key": OPENROUTER_KEY_OK})
    read = await server.read(service(OPENROUTER))
    assert [m.id for m in read.models] == ["v/a"]
    assert all(r.url.host == "openrouter.ai" for r in server.requests)


async def test_openrouter_refuses_a_bad_key_although_its_list_is_public():
    listing = {"data": [{"id": "v/a"}]}
    refused = Server({"/api/v1/models": listing, "/api/v1/key": httpx.Response(
        401, json={"error": {"message": "No auth credentials found"}})})
    with pytest.raises(ProviderError) as raised:
        await refused.read(service(OPENROUTER))
    assert raised.value.kind == AUTH_REFUSED

    for key in (httpx.Response(404), ConnectionRefusedError):
        def answer(request: httpx.Request, key=key):
            if key is ConnectionRefusedError:
                raise httpx.ConnectError("refused", request=request)
            return key

        server = Server({"/api/v1/models": listing, "/api/v1/key": answer})
        assert [m.id for m in (await server.read(service(OPENROUTER))).models] == ["v/a"]


# What cannot chat


async def test_what_cannot_chat_is_not_relayed():
    entries = [
        {"id": "x/y"},
        {"id": "x/y:batch"},
        {"id": "x/y:free"},
        {"id": "x/painter", "architecture": {"output_modalities": ["image"]}},
        {"id": "x/talker", "architecture": {"output_modalities": ["text"]}},
    ]
    server = Server({"/api/v1/models": {"data": entries}, "/api/v1/key": OPENROUTER_KEY_OK})
    read = await server.read(service(OPENROUTER))
    assert len(read.models) == 5
    assert [m["id"] for m in relayed(read)] == ["x/y", "x/y:free", "x/talker"]
    assert dropped(read) == {"batch": 1}

    listing = fixture("openai_models.json")
    for base_url, family, relayed_ids in [
        ("https://api.openai.com/v1", "openai", ["gpt-4o"]),
        ("https://proxy.example.com/v1", "generic", [m["id"] for m in listing["data"]]),
    ]:
        server = Server({"/v1/models": listing})
        read = await server.read(service(base_url), probes=False)
        assert read.family == family
        assert [m["id"] for m in relayed(read)] == relayed_ids


async def test_a_text_and_music_model_at_zero_has_no_price():
    entries = [
        {"id": "v/song", "architecture": {"output_modalities": ["text", "audio"]},
         "pricing": {"prompt": "0", "completion": "0"}},
        {"id": "v/paid-song", "architecture": {"output_modalities": ["text", "audio"]},
         "pricing": {"prompt": "0.000001", "completion": "0.000001"}},
        {"id": "v/free", "architecture": {"output_modalities": ["text"]},
         "pricing": {"prompt": "0", "completion": "0"}},
    ]
    server = Server({"/api/v1/models": {"data": entries}, "/api/v1/key": OPENROUTER_KEY_OK})
    models = by_id(await server.read(service(OPENROUTER)))
    assert (models["v/song"].price_in, models["v/song"].price_out) == (None, None)
    assert models["v/paid-song"].price_in == 1.0
    assert (models["v/free"].price_in, models["v/free"].price_out) == (0.0, 0.0)


async def test_lm_studio_does_not_offer_its_embedding_models():
    base = "http://localhost:1234/v1"
    native = {"models": [{"type": "llm", "key": "brume-12b"},
                         {"type": "embedding", "key": "text-embedding-nomic-embed-text-v1.5"}]}
    listing = {"data": [{"id": "brume-12b"}, {"id": "text-embedding-nomic-embed-text-v1.5"}]}
    server = Server({"/v1/models": listing, "/api/v1/models": native})
    read = await server.read(service(base))
    assert read.family == "lmstudio"
    assert [m["id"] for m in relayed(read)] == ["brume-12b"]

    server = Server({"/v1/models": listing})
    read = await server.read(service(base))
    assert [m["id"] for m in relayed(read)] == [
        "brume-12b", "text-embedding-nomic-embed-text-v1.5"]


# The cache


async def test_a_list_is_kept_ten_minutes_unless_asked_fresh(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr("app.providers.catalog._now", lambda: now[0])
    server = Server({"/v1/models": {"data": [{"id": "a"}]}})
    svc = service("https://proxy.example.com/v1")

    async def read(svc: dict, fresh: bool = False):
        return await server.read(svc, probes=False, fresh=fresh)

    await read(svc)
    now[0] += 9 * MINUTES
    await read(svc)
    assert len(server.requests) == 1

    now[0] += 2 * MINUTES
    await read(svc)
    assert len(server.requests) == 2

    await read(svc, fresh=True)
    assert len(server.requests) == 3

    await read({**svc, "api_key": "sk-another"})
    assert len(server.requests) == 4
    # The same address with its final "/" is the same list.
    await read({**svc, "base_url": svc["base_url"] + "/"})
    assert len(server.requests) == 4


async def test_a_list_that_failed_is_not_kept():
    calls = []

    def answer(_: httpx.Request):
        calls.append(1)
        return httpx.Response(503) if len(calls) == 1 else {"data": [{"id": "a"}]}

    server = Server({"/v1/models": answer})
    svc = service("https://proxy.example.com/v1")
    with pytest.raises(ProviderError):
        await server.read(svc, probes=False, fresh=False)
    assert [m.id for m in (await server.read(svc, probes=False, fresh=False)).models] == ["a"]


async def test_a_memory_pass_reads_its_reasoning_through_the_catalog(monkeypatch):
    """One reader of OpenRouter's list: the least reasoning a memory pass asks for comes from the
    list a probe has just read, kept six hours for it, and a list that failed waits five minutes."""
    now = [1000.0]
    monkeypatch.setattr("app.providers.catalog._now", lambda: now[0])
    monkeypatch.setattr("app.providers.openai_compat._now", lambda: now[0])
    model = "deepseek/deepseek-v4.1-flash"
    listing = {"data": [{"id": model, "reasoning": {
        "mandatory": False, "default_enabled": True, "supported_efforts": ["high", "low", "none"]}}],
        "links": {"next": None}}
    chats: list[dict] = []

    def chat(request: httpx.Request):
        chats.append(json.loads(request.content))
        return httpx.Response(200, content=sse([
            json.dumps({"choices": [{"delta": {"content": "{}"}, "finish_reason": "stop"}]}),
            "[DONE]"]))

    server = Server({"/api/v1/models": lambda _: listing, "/api/v1/key": OPENROUTER_KEY_OK,
                     "/api/v1/chat/completions": chat})
    monkeypatch.setattr(catalog, "client_factory", server.factory)
    svc = service(OPENROUTER, model=model)

    def lists() -> int:
        return server.paths().count("/api/v1/models")

    async def memory_pass() -> dict:
        provider = OpenAICompatProvider({**svc, "least_reasoning": True})
        provider._client_factory = server.factory
        assert (await complete_answer(provider, PAYLOAD)).text == "{}"
        return chats[-1]

    probed = await read_catalog(svc)
    assert all("reasoning" not in shown for shown in relayed(probed))
    assert (await memory_pass())["reasoning"] == {"effort": "none"}
    assert lists() == 1

    now[0] += 6 * HOURS - 1 * MINUTES
    assert (await memory_pass())["reasoning"] == {"effort": "none"}
    assert lists() == 1
    now[0] += 2 * MINUTES
    assert (await memory_pass())["reasoning"] == {"effort": "none"}
    assert lists() == 2

    server.routes["/api/v1/models"] = lambda _: httpx.Response(503)
    now[0] += 7 * HOURS
    assert "reasoning" not in await memory_pass()
    assert lists() == 3
    now[0] += 4 * MINUTES
    assert "reasoning" not in await memory_pass()
    assert lists() == 3
    server.routes["/api/v1/models"] = lambda _: listing
    now[0] += 2 * MINUTES
    assert (await memory_pass())["reasoning"] == {"effort": "none"}
    assert lists() == 4


# Prices and odd values


def test_amount_takes_a_price_already_per_million():
    assert amount(3.0) == 3.0
    assert amount(0) == 0.0
    for odd in (-1, float("inf"), float("nan"), "x", "3", True, None):
        assert amount(odd) is None
    # The trap it is there for: a price per million read as a price per token.
    assert per_million(3.0) == 3_000_000.0


def test_per_million_reads_a_price_per_token_without_rounding_errors():
    assert per_million("0.000003") == 3.0
    assert per_million("0.0000003") == 0.3
    assert per_million("0") == 0.0
    for odd in ("-1", "nan", "inf", "x", "", None, True, "1e400000"):
        assert per_million(odd) is None


async def test_odd_values_are_not_told():
    assert whole("131072") == 131072
    assert whole(131072.0) == 131072
    assert whole(2**53 - 1) == 2**53 - 1
    for odd in ("lots", 0, -5, True, 1e400, 2**60, 1.5, "1.5", None, {"n": 1}, [8192]):
        assert whole(odd) is None

    entries = [
        {"id": "v/a", "context_length": {"value": 8192}, "created": "yesterday",
         "top_provider": "none", "pricing": "free", "architecture": "text",
         "supported_parameters": "reasoning", "reasoning": "yes"},
        {"id": "v/half\ud83d", "name": "Brume: Half \ud83d moon"},
        {"id": 12, "name": 7},
        {"name": "no id"},
        "not an object",
        {"id": ""},
        {"id": "v/a", "name": "A second v/a: the first is kept"},
    ]
    server = Server({"/api/v1/models": {"data": entries}, "/api/v1/key": OPENROUTER_KEY_OK})
    read = await server.read(service(OPENROUTER))
    models = by_id(read)
    assert list(models) == ["v/a", "v/half�", "12"]
    odd = models["v/a"]
    assert (odd.served, odd.created, odd.max_output, odd.price_in, odd.reasons) == (
        None, None, None, None, False)
    assert odd.name is None and odd.chats
    assert models["v/half�"].name == "Brume: Half � moon"
    assert models["12"].name is None
    json.dumps(relayed(read)).encode("utf-8")


# Each shape a field can come in that is not the one its documentation gives.
ODD = [None, True, 0, -1, 1.5, 2**80, "text", "", "1e999999", "http://[::1", [], [1], [{"x": 1}],
       {}, {"x": 1}]
# A body nested deeper than Python's own parser can follow.
DEEP = b"[" * 100_000 + b"]" * 100_000


def put(value, path: tuple, odd):
    """``value`` with the field at ``path`` (keys and list indexes) set to ``odd``."""
    value = copy.deepcopy(value)
    here = value
    for step in path[:-1]:
        here = here[step]
    here[path[-1]] = odd
    return value


def sane(read: Catalog) -> None:
    """Every field of every model is of the type it is declared with, and the page can take it."""
    for m in read.models:
        assert isinstance(m.id, str)
        for text in (m.name, m.vendor):
            assert text is None or isinstance(text, str)
        for count in (m.created, m.served, m.configured, m.max, m.max_output):
            assert count is None or (type(count) is int and 0 < count <= 2**53 - 1)
        for price in (m.price_in, m.price_out, m.price_cache_read, m.price_cache_write):
            assert price is None or (type(price) is float and math.isfinite(price) and price >= 0)
        assert m.reasoning is None or isinstance(m.reasoning, dict)
        assert m.reasons in (None, True, False)
        assert all(type(flag) is bool for flag in (m.price_varies, m.chats, m.batch))
        least_reasoning(m.reasoning)
    json.dumps(relayed(read)).encode("utf-8")


OPENROUTER_ENTRY = {
    "id": "v/a", "name": "V: A", "created": 1794614400, "context_length": 8192,
    "top_provider": {"max_completion_tokens": 1024},
    "pricing": {"prompt": "0.000001", "completion": "0.000002", "input_cache_read": "0",
                "input_cache_write": "0"},
    "architecture": {"output_modalities": ["text"]},
    "reasoning": {"mandatory": False, "default_enabled": True, "supported_efforts": ["low", "none"]},
    "supported_parameters": ["reasoning"],
}
OPENROUTER_FIELDS = [
    ("name",), ("created",), ("context_length",), ("top_provider",),
    ("top_provider", "max_completion_tokens"), ("pricing",), ("pricing", "prompt"),
    ("pricing", "completion"), ("pricing", "input_cache_read"), ("pricing", "input_cache_write"),
    ("architecture",), ("architecture", "output_modalities"),
    ("architecture", "output_modalities", 0), ("reasoning",), ("reasoning", "mandatory"),
    ("reasoning", "default_enabled"), ("reasoning", "supported_efforts"),
    ("reasoning", "supported_efforts", 0), ("supported_parameters",), ("supported_parameters", 0),
]


async def test_a_field_of_an_odd_shape_never_breaks_openrouter_s_list():
    for path in OPENROUTER_FIELDS:
        for odd in ODD:
            entry = put(OPENROUTER_ENTRY, path, odd)
            server = Server({"/api/v1/models": {"data": [entry], "links": {"next": None}},
                             "/api/v1/key": OPENROUTER_KEY_OK})
            read = await server.read(service(OPENROUTER))
            assert [m.id for m in read.models] == ["v/a"], (path, odd)
            sane(read)
    # The page around the entries: where its next page is. An address that cannot be read ends
    # the list on what it has; one that can is asked, and a refusal there is the list's own.
    for links in [*ODD, *({"next": odd} for odd in [*ODD, "//[", "http://[::1]:x/", "::::"])]:
        server = Server({"/api/v1/models": {"data": [OPENROUTER_ENTRY], "links": links},
                         "/api/v1/key": OPENROUTER_KEY_OK})
        try:
            read = await server.read(service(OPENROUTER))
        except ProviderError:
            assert set(server.paths()) - {"/api/v1/models", "/api/v1/key"}, links
            continue
        assert [m.id for m in read.models] == ["v/a"], links
        sane(read)
    for unreadable in ("http://[::1", "//[", "http://[::1]:x/"):
        server = Server({"/api/v1/models": {"data": [OPENROUTER_ENTRY],
                                            "links": {"next": unreadable}},
                         "/api/v1/key": OPENROUTER_KEY_OK})
        assert [m.id for m in (await server.read(service(OPENROUTER))).models] == ["v/a"]


async def test_a_field_of_an_odd_shape_never_breaks_another_family_s_list():
    anthropic = {"type": "model", "id": "claude-a", "display_name": "Claude A",
                 "max_input_tokens": 200000, "max_tokens": 64000}
    for path in [("display_name",), ("max_input_tokens",), ("max_tokens",)]:
        for odd in ODD:
            server = Server({"/v1/models": {"data": [put(anthropic, path, odd)]}})
            read = await server.read(service("https://api.anthropic.com", provider="anthropic"))
            assert [m.id for m in read.models] == ["claude-a"], (path, odd)
            sane(read)
    for odd in ODD:
        for page in ({"data": [anthropic], "has_more": odd, "last_id": "claude-a"},
                     {"data": [anthropic], "has_more": True, "last_id": odd}):
            server = Server({"/v1/models": page})
            read = await server.read(service("https://api.anthropic.com", provider="anthropic"))
            assert [m.id for m in read.models] == ["claude-a"], page
            sane(read)

    generic = {"id": "m", "context_window": 8192, "max_context_length": 8192,
               "context_length": 8192, "max_model_len": 8192, "max_completion_tokens": 1024,
               "meta": {"n_ctx": 8192, "n_ctx_train": 131072}}
    for path in [("context_window",), ("max_context_length",), ("context_length",),
                 ("max_model_len",), ("max_completion_tokens",), ("meta",), ("meta", "n_ctx"),
                 ("meta", "n_ctx_train")]:
        for odd in ODD:
            server = Server({"/v1/models": {"data": [put(generic, path, odd)]}})
            read = await server.read(service("https://proxy.example.com/v1"), probes=False)
            assert [m.id for m in read.models] == ["m"], (path, odd)
            sane(read)


async def test_a_native_answer_of_an_odd_shape_is_not_told_and_breaks_nothing():
    lmstudio = {"key": "brume", "type": "llm", "display_name": "Brume",
                "max_context_length": 131072, "capabilities": {"reasoning": {"default": "on"}},
                "loaded_instances": [{"config": {"context_length": 8192}}]}
    ps = {"name": "brume", "model": "brume", "context_length": 8192}
    show = {"model_info": {"llama.context_length": 131072}, "parameters": "num_ctx 16384"}
    cases = [
        ("http://localhost:1234/v1", "/api/v1/models", lambda path, odd: {
            "models": [put(lmstudio, path, odd)]}, [
            ("key",), ("type",), ("display_name",), ("max_context_length",), ("capabilities",),
            ("capabilities", "reasoning"), ("capabilities", "reasoning", "default"),
            ("loaded_instances",), ("loaded_instances", 0), ("loaded_instances", 0, "config"),
            ("loaded_instances", 0, "config", "context_length")]),
        ("http://localhost:11434/v1", "/api/ps", lambda path, odd: {
            "models": [put(ps, path, odd)]}, [("name",), ("model",), ("context_length",)]),
        ("http://localhost:11434/v1", "/api/show", lambda path, odd: put(show, path, odd), [
            ("model_info",), ("model_info", "llama.context_length"), ("parameters",)]),
        ("http://localhost:8080/v1", "/props", lambda path, odd: {
            "default_generation_settings": put({"n_ctx": 8192}, path, odd)}, [("n_ctx",)]),
        ("http://localhost:5001/v1", "/api/extra/true_max_context_length",
         lambda path, odd: put({"value": 12288}, path, odd), [("value",)]),
    ]
    for base, route, answer, paths in cases:
        for path in paths:
            for odd in ODD:
                server = Server({"/v1/models": {"data": [{"id": "brume"}]},
                                 route: answer(path, odd)})
                read = await server.read(service(base))
                assert [m.id for m in read.models] == ["brume"], (route, path, odd)
                sane(read)
                listed, _ = await read_one(service(base), "brume", client_factory=server.factory)
                sane(Catalog("generic", "", [listed]))
        # The whole answer of an odd shape, or nested past what the parser follows.
        for whole_answer in [*ODD, httpx.Response(200, content=DEEP)]:
            server = Server({"/v1/models": {"data": [{"id": "brume"}]}, route: whole_answer})
            read = await server.read(service(base))
            assert [m.id for m in read.models] == ["brume"], (route, whole_answer)
            await read_one(service(base), "brume", client_factory=server.factory)
    # A generic address, whose every probe answers past the parser's depth.
    deep = httpx.Response(200, content=DEEP)
    server = Server({"/v1/models": {"data": [{"id": "brume"}]}, "/api/ps": deep,
                     "/api/v1/models": deep, "/props": deep,
                     "/api/extra/true_max_context_length": deep})
    assert (await server.read(service())).family == "generic"


async def test_a_list_nested_past_the_parser_s_depth_is_unreadable_not_a_crash():
    for svc, route in [(service("https://proxy.example.com/v1"), "/v1/models"),
                       (service(OPENROUTER), "/api/v1/models")]:
        server = Server({route: httpx.Response(200, content=DEEP),
                         "/api/v1/key": OPENROUTER_KEY_OK})
        with pytest.raises(ProviderError) as raised:
            await server.read(svc, probes=False)
        assert raised.value.kind == "model_unreadable"
    # A refusal whose words are nested as deep still says its status.
    server = Server({"/api/v1/models": {"data": [{"id": "v/a"}]},
                     "/api/v1/key": httpx.Response(401, content=DEEP)})
    with pytest.raises(ProviderError) as raised:
        await server.read(service(OPENROUTER))
    assert (raised.value.kind, raised.value.message) == (AUTH_REFUSED, "HTTP 401")


# The other families


async def test_anthropic_reads_every_page():
    def pages(request: httpx.Request):
        after = request.url.params.get("after_id")
        start = 0 if after is None else int(after.removeprefix("claude-")) + 1
        ids = [f"claude-{n}" for n in range(start, min(start + 1000, 2012))]
        return {"data": [{"type": "model", "id": i} for i in ids],
                "has_more": start + 1000 < 2012, "first_id": ids[0], "last_id": ids[-1]}

    server = Server({"/v1/models": pages})
    read = await server.read(service("https://api.anthropic.com", provider="anthropic"))
    assert (read.family, len(read.models)) == ("anthropic", 2012)
    assert len(server.requests) == 3
    assert server.requests[0].url.params["limit"] == "1000"
    assert server.requests[0].headers["x-api-key"] == KEY

    def same_page(_: httpx.Request):
        return {"data": [{"id": "claude-a"}], "has_more": True, "last_id": "claude-a"}

    server = Server({"/v1/models": same_page})
    read = await server.read(service("https://api.anthropic.com", provider="anthropic"))
    assert [m.id for m in read.models] == ["claude-a"]
    assert len(server.requests) == 2

    server = Server({"/v1/models": fixture("anthropic_models.json")})
    models = by_id(await server.read(service("https://api.anthropic.com", provider="anthropic")))
    brume = models["claude-brume-4"]
    assert (brume.name, brume.served, brume.max_output, brume.reasons) == (
        "Claude Brume 4", 200000, 64000, None)


async def test_lm_studio_reads_what_is_loaded_and_its_maximum():
    server = Server({"/v1/models": fixture("lmstudio_openai_models.json"),
                     "/api/v1/models": fixture("lmstudio_v1_models.json")})
    read = await server.read(service("http://localhost:1234/v1"))
    models = by_id(read)
    brume = models["brume-12b"]
    assert (brume.served, brume.max, brume.name, brume.reasons) == (8192, 131072, "Brume 12B", None)
    givre = models["givre-r1-8b"]
    assert (givre.served, givre.max, givre.reasons) == (None, 32768, True)
    assert not models["text-embedding-nomic-embed-text-v1.5"].chats

    # An LM Studio before the v1 REST API: its v0 list says the same.
    server = Server({"/v1/models": fixture("lmstudio_openai_models.json"),
                     "/api/v0/models": {"data": [
                         {"id": "brume-12b", "type": "llm", "max_context_length": 65536,
                          "loaded_context_length": 4096}]}})
    models = by_id(await server.read(service("http://localhost:1234/v1")))
    assert models["brume-12b"].max == 65536


async def test_llama_cpp_reads_its_slot_size():
    # shape unverified: "meta" in the entries of /v1/models.
    server = Server({"/v1/models": fixture("llamacpp_models.json"),
                     "/props": fixture("llamacpp_props.json")})
    read = await server.read(service("http://localhost:8080/v1"))
    (model,) = read.models
    assert (read.family, model.served, model.max) == ("llamacpp", 8192, 131072)


@pytest.mark.parametrize("answer", [12288, {"value": 12288}])
async def test_koboldcpp_reads_a_bare_number_or_an_object(answer):
    # shape unverified: KoboldCpp's answer.
    assert fixture("koboldcpp_true_max_context_length.json") == {"value": 12288}
    server = Server({"/v1/models": {"data": [{"id": "koboldcpp/Brume-12B"}]},
                     "/api/extra/true_max_context_length": answer})
    read = await server.read(service("http://localhost:5001/v1"))
    assert (read.family, read.models[0].served) == ("koboldcpp", 12288)


async def test_ollama_tells_loaded_configured_and_maximum_apart():
    # shape unverified: "context_length" in /api/ps.
    server = Server({"/v1/models": fixture("ollama_openai_models.json"),
                     "/api/ps": fixture("ollama_ps.json"),
                     "/api/show": fixture("ollama_show.json")})
    svc = service("http://localhost:11434/v1")
    read = await server.read(svc)
    models = by_id(read)
    assert (models["brume:12b"].served, models["givre:8b"].served) == (8192, None)
    assert "/api/show" not in server.paths()

    listed, family = await read_one(svc, "brume:12b", client_factory=server.factory)
    assert family == "ollama"
    assert (listed.served, listed.configured, listed.max) == (8192, 16384, 131072)
    shown = [r for r in server.requests if r.url.path == "/api/show"]
    assert [json.loads(r.content) for r in shown] == [{"model": "brume:12b"}]

    gone, _ = await read_one(svc, "gone:1b", client_factory=server.factory)
    assert gone is None


async def test_a_generic_address_tries_every_probe_and_learns_its_family():
    listing = {"data": [{"id": f"m{n}"} for n in range(300)]}
    lmstudio = {"models": [{"key": "m0", "type": "llm"}]}
    server = Server({"/v1/models": listing, "/api/v1/models": lmstudio})
    read = await server.read(service())
    assert read.family == "lmstudio"
    probes = ["/api/ps", "/api/v1/models", "/props", "/api/extra/true_max_context_length"]
    assert all(server.paths().count(path) <= 1 for path in probes)
    assert "/api/show" not in server.paths()

    # The browser's mock server answers every path alike: no family.
    server = Server({path: {"ok": True} for path in probes} | {"/v1/models": listing})
    assert (await server.read(service())).family == "generic"

    async def props_first(_: httpx.Request):
        return {"default_generation_settings": {"n_ctx": 4096}}

    async def lmstudio_later(_: httpx.Request):
        await asyncio.sleep(0.2)
        return lmstudio

    server = Server({"/v1/models": listing, "/props": props_first,
                     "/api/v1/models": lmstudio_later})
    assert (await server.read(service())).family == "lmstudio"

    # The list alone: no probe.
    server = Server({"/v1/models": listing})
    assert (await server.read(service(), probes=False)).family == "generic"
    assert server.paths() == ["/v1/models"]


async def test_a_slow_or_dead_probe_is_not_told_and_does_not_hold_the_list():
    async def asleep(_: httpx.Request):
        await asyncio.sleep(10)
        return {"models": []}

    def refused(request: httpx.Request):
        raise httpx.ConnectError("refused", request=request)

    server = Server({"/v1/models": {"data": [{"id": "a"}]}, "/api/ps": asleep,
                     "/props": refused})
    started = time.monotonic()
    read = await server.read(service())
    assert time.monotonic() - started < 3
    assert (read.family, [m.id for m in read.models]) == ("generic", ["a"])


async def test_a_trickling_server_is_given_up_after_the_whole_delay(monkeypatch):
    monkeypatch.setattr("app.providers.catalog.LIST_WHOLE_S", 0.3)

    class Trickle(httpx.AsyncByteStream):
        async def __aiter__(self):
            for byte in b'{"data": []}':
                yield bytes([byte])
                await asyncio.sleep(5)

    server = Server({"/v1/models": lambda _: httpx.Response(200, stream=Trickle())})
    started = time.monotonic()
    with pytest.raises(ProviderError) as raised:
        await server.read(service("https://proxy.example.com/v1"), probes=False)
    assert raised.value.kind == LIST_TIMEOUT
    assert time.monotonic() - started < 2


async def test_a_list_too_large_to_hold_is_refused(monkeypatch):
    monkeypatch.setattr("app.providers.catalog.LIST_MAX_BYTES", 100)
    server = Server({"/v1/models": {"data": [{"id": f"model-{n}"} for n in range(50)]}})
    with pytest.raises(ProviderError) as raised:
        await server.read(service("https://proxy.example.com/v1"), probes=False)
    assert raised.value.kind == "model_unreadable"
    assert "too large" in raised.value.message


async def test_a_dead_server_and_an_unreadable_list_say_what_failed():
    def refused(request: httpx.Request):
        raise httpx.ConnectError("refused", request=request)

    server = Server({"/v1/models": refused})
    with pytest.raises(ProviderError) as raised:
        await server.read(service("http://192.168.1.20:5000/v1/"), probes=False)
    assert (raised.value.kind, raised.value.message) == (UNREACHABLE, "http://192.168.1.20:5000/v1")

    server = Server({"/v1/models": httpx.Response(200, text="<html>Welcome</html>")})
    with pytest.raises(ProviderError) as raised:
        await server.read(service(), probes=False)
    assert raised.value.kind == "model_unreadable"


async def test_no_test_reaches_a_real_address():
    """Unless a test sets its own transport, the catalog's one door refuses every request."""
    with pytest.raises(ProviderError) as raised:
        await read_catalog(service(OPENROUTER))
    assert raised.value.kind == UNREACHABLE


# The key


async def test_a_server_that_echoes_the_key_does_not_show_it():
    said = {"error": {"message": f"Invalid key {KEY} for this account"}}
    for status in (401, 500):
        server = Server({"/v1/models": httpx.Response(status, json=said)})
        with pytest.raises(ProviderError) as raised:
            await server.read(service("https://proxy.example.com/v1"), probes=False)
        assert "…4f2a" in raised.value.message
        assert "sk-test-SECRET" not in raised.value.message

    streams = [
        (oai_provider, sse([json.dumps({"choices": [{"delta": {"content": "Hel"}}]}),
                            json.dumps({"error": {"message": f"Key {KEY} is out of credit"}}),
                            "[DONE]"])),
        (anth_provider, sse([json.dumps({"type": "error",
                                         "error": {"message": f"Key {KEY} is out of credit"}})])),
    ]
    for make, body in streams:
        provider = make(lambda _, body=body: httpx.Response(200, content=body))
        provider.api_key = KEY
        with pytest.raises(ProviderError) as raised:
            await collect(provider, PAYLOAD)
        assert "…4f2a" in raised.value.message
        assert "sk-test-SECRET" not in raised.value.message


async def test_a_key_echoed_where_its_words_are_cut_shows_none_of_itself():
    """The words of an error are cut to a length: the key is taken out of the whole of them
    first, so that a key that straddles the cut leaves nothing of itself behind."""
    key = "sk-or-v1-" + "0123456789abcdef" * 4  # 73 characters, as OpenRouter's
    said = {"error": {"message": "x" * 250 + f" key {key} is not valid"}}

    def shows_none_of_the_key(message: str) -> None:
        assert all(key[n:n + 8] not in message for n in range(len(key) - 8)), message
        assert f"…{key[-4:]}" in message

    server = Server({"/v1/models": httpx.Response(401, json=said)})
    with pytest.raises(ProviderError) as raised:
        await server.read(service("https://proxy.example.com/v1", api_key=key), probes=False)
    shows_none_of_the_key(raised.value.message)

    refused = sse([json.dumps(said)])
    for make, answer in [
        (oai_provider, httpx.Response(401, json=said)),
        (anth_provider, httpx.Response(401, json=said)),
        (oai_provider, httpx.Response(200, content=refused)),
        (anth_provider, httpx.Response(200, content=sse([json.dumps({"type": "error", **said})]))),
    ]:
        provider = make(lambda _, answer=answer: answer)
        provider.api_key = key
        with pytest.raises(ProviderError) as raised:
            await collect(provider, PAYLOAD)
        shows_none_of_the_key(raised.value.message)


# Families, addresses and names


def test_a_family_holds_for_the_address_it_was_decided_at():
    assert family_of("openai-compatible", OPENROUTER, "lmstudio", OPENROUTER) == "openrouter"
    lan = "http://192.168.1.20:1234/v1"
    assert family_of("openai-compatible", lan, "lmstudio", lan) == "lmstudio"
    assert family_of("openai-compatible", lan + "/", "lmstudio", lan) == "lmstudio"
    assert family_of("openai-compatible", lan, "lmstudio", lan + "/") == "lmstudio"
    assert family_of("openai-compatible", lan, "lmstudio",
                     "http://192.168.1.20:11434/v1") == "generic"
    assert family_of("openai-compatible", lan, "lmstudio", None) == "generic"
    assert family_of("openai-compatible", "http://localhost:1234/v1", "openrouter",
                     OPENROUTER) == "lmstudio"
    assert family_of("anthropic", "https://gateway.example.com", "generic", None) == "anthropic"


def test_is_local_by_family_and_address():
    for host in ("192.168.1.20", "10.0.0.5", "pc.local", "localhost", "nas",
                 "host.docker.internal", "pc.lan", "pc.home.arpa", "[::1]", "169.254.1.2"):
        assert is_local("generic", f"http://{host}:8000/v1"), host
    assert not is_local("generic", "https://api.example.com/v1")
    assert not is_local("openrouter", "http://127.0.0.1:8000/v1")
    assert not is_local("llamacpp", "http://gpu.example.com:8080/v1")
    assert is_local("lmstudio", "http://192.168.1.20:1234/v1")
    assert is_loopback("http://localhost:1234/v1")
    assert is_loopback("http://127.0.0.1:1234/v1")
    assert not is_loopback("http://192.168.1.20:1234/v1")


def test_service_names():
    assert service_name("openrouter", OPENROUTER, set()) == "OpenRouter"
    assert service_name("openrouter", OPENROUTER, {"OpenRouter"}) == "OpenRouter (2)"
    assert service_name("openrouter", OPENROUTER, {"OpenRouter", "OpenRouter (2)"}) == (
        "OpenRouter (3)")
    assert service_name("generic", "http://192.168.1.20:8000/v1", set()) == "192.168.1.20:8000"
    assert service_name("lmstudio", "http://localhost:1234/v1", set()) == "LM Studio"


def test_root_and_display_names():
    assert catalog.root_of("http://localhost:11434/v1/") == "http://localhost:11434"
    assert catalog.root_of("http://localhost:5000") == "http://localhost:5000"
    plain = Listed(id="brume/brume-12b", name=None, vendor="brume", created=None, served=None,
                   configured=None, max=None, max_output=None, reasoning=None, price_in=None,
                   price_out=None, price_cache_read=None, price_cache_write=None,
                   price_varies=False, reasons=None, chats=True, batch=False)
    assert display_name(plain, "generic") == "brume-12b"


# The list as the page receives it


async def test_the_relayed_list_of_471_models_is_whole_and_light():
    server = Server({"/api/v1/models": fixture("openrouter_471.json"),
                     "/api/v1/key": OPENROUTER_KEY_OK})
    read = await server.read(service(OPENROUTER))
    assert len(read.models) == 471
    assert sum(m.batch for m in read.models) == 87
    shown = relayed(read)
    assert len(shown) == 384
    assert dropped(read) == {"batch": 87}
    raw = json.dumps(shown, separators=(",", ":")).encode("utf-8")
    packed = gzip.compress(raw, compresslevel=6)
    assert len(packed) < 15_000, (len(raw), len(packed))
    assert all("reasoning" not in model for model in shown)
    assert set(shown[0]) == {"id", "name", "vendor", "created", "context", "max_output", "price",
                             "reasons"}
    named = {m["name"] for m in shown}
    assert {"Mistral Large", "Eclair Mini", "Obsidienne", "Aurore Large", "Sillage 7B"} <= named
