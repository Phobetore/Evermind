"""What the test files share: they import from here, never from one another."""

import asyncio
import base64
import json
import uuid
from contextlib import asynccontextmanager
from typing import ClassVar

import httpx
import pytest

from app.prompting.engine import PromptPayload
from app.providers.anthropic import AnthropicProvider
from app.providers.base import ProviderEvent
from app.providers.openai_compat import OpenAICompatProvider
from app.services import card_assistant, turns

# A 1x1 image, for the tests that send one.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def _default_settings(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("EVERMIND_GATE_PASSWORD", raising=False)
    monkeypatch.setenv("EVERMIND_UI_DIR", str(tmp_path / "no-ui"))


@pytest.fixture(autouse=True)
def _no_developer_settings(tmp_path, monkeypatch):
    """What the developer has set must not change what a test sees: a password
    left in the shell would lock every API test, and a real built interface
    would answer routes that tests expect to be missing."""
    _default_settings(tmp_path, monkeypatch)


@pytest.fixture(autouse=True)
def _no_wrong_passwords_counted():
    # The server counts them per process, and every test client has the same address.
    from app import gate

    gate._failures.clear()


@pytest.fixture(autouse=True)
def _no_card_drafts_from_another_test():
    # The server keeps them in its memory, which every test shares.
    card_assistant._jobs.clear()


@pytest.fixture()
async def make_client(tmp_path, monkeypatch):
    """Open clients on fresh applications that all share one data directory.

    ``make_client(**env)`` is an async context manager. Each call is a restart:
    a new application, with the defaults above plus ``env``, on the same
    database as the previous one. That is what lets a test log in, change the
    password and see what the next start makes of the old session.
    """
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / f"data-{uuid.uuid4().hex}"))

    @asynccontextmanager
    async def make(**env: str):
        # Start from the defaults every time, so that a call says everything
        # about the configuration it starts with.
        _default_settings(tmp_path, monkeypatch)
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        from app.db import init_db
        from app.main import create_app

        app = create_app()
        await init_db()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
            yield c

    yield make

    # Let fire-and-forget background tasks (memory maintenance) finish before
    # the temp database directory is torn down.
    pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    if pending:
        await asyncio.wait(pending, timeout=2)


@pytest.fixture()
async def client(make_client):
    """HTTP client over the ASGI app, backed by a temporary database."""
    async with make_client() as c:
        yield c


class FakeProvider:
    """Yields scripted events, and raises a scripted error; records the payload it received."""

    # Shared on the class on purpose: the service instantiates the provider
    # itself, so the tests have nowhere else to read the captured payload from.
    captured: ClassVar[dict] = {}

    def __init__(self, connection):
        self.connection = connection

    async def stream_chat(self, payload):
        FakeProvider.captured["payload"] = payload
        FakeProvider.captured["connection"] = self.connection
        for event in FakeProvider.script:
            if isinstance(event, Exception):
                raise event
            yield event


async def setup_conversation(client, greeting="*She stirs.* Hi {{user}}."):
    char = (await client.post("/api/characters", json={"name": "Serana", "greeting": greeting})).json()
    (await client.post("/api/personas", json={"name": "Alex"})).json()
    (await client.post("/api/connections", json={
        "name": "Local", "provider": "openai-compatible",
        "base_url": "http://localhost:1234/v1", "model": "test",
    })).json()
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    return convo


async def send(client, convo_id, content="Hello there", mode="send", **fields) -> dict | None:
    """A turn, from asking for it to its end, and how it ended when it failed or added nothing."""
    resp = await client.post("/api/chat", json={
        "conversation_id": convo_id, "mode": mode, "content": content, **fields,
    })
    assert resp.status_code == 200, resp.text
    turn = await turns.running_for(convo_id)
    if turn:
        await turn.finished.wait()
    return (await client.get(f"/api/conversations/{convo_id}/turn")).json()["outcome"]


async def messages_of(client, convo_id) -> list[dict]:
    return (await client.get(f"/api/conversations/{convo_id}")).json()["messages"]


async def extract(client, convo_id, reply):
    FakeProvider.script = [ProviderEvent(type="delta", text=json.dumps(reply)),
                           ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo_id}/memories/extract")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def stored_facts(client, convo_id):
    """What the conversation remembers, as one comparable list."""
    rows = (await client.get(f"/api/conversations/{convo_id}/memories")).json()
    return sorted((m["content"], m["source_position"], m["is_pinned"], m["source"])
                  for m in rows)


def waiting_provider(monkeypatch):
    """A provider for the memory passes that does not answer until ``release`` is set,
    and says when it was asked and with what."""
    started, release, asked = asyncio.Event(), asyncio.Event(), []

    class Waiting(FakeProvider):
        async def stream_chat(self, payload):
            asked.append(payload)
            started.set()
            await release.wait()
            async for event in super().stream_chat(payload):
                yield event

    monkeypatch.setattr("app.services.memory_service.get_provider", Waiting)
    return started, release, asked


async def within(seconds, awaitable):
    """So that a pass that waits for another fails the test instead of hanging it."""
    return await asyncio.wait_for(awaitable, seconds)


async def assist(client, **body) -> dict:
    """A card asked of the assistant, and the state its job ended in."""
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate", **body})
    assert resp.status_code == 202, resp.text
    job_id = resp.json()["id"]
    await within(2, card_assistant._jobs[job_id].finished.wait())
    return (await client.get(f"/api/characters/assist/{job_id}")).json()


PAYLOAD = PromptPayload(
    system="You are Serana.",
    messages=[
        {"role": "assistant", "content": "*She stirs.*"},
        {"role": "user", "content": "Hello"},
    ],
    stop=["\nAlex:"],
    post_history="Stay tense.",
)

OAI_CONN = {
    "provider": "openai-compatible",
    "base_url": "http://mock/v1",
    "api_key": "sk-test",
    "model": "test-model",
    "context_size": 8192,
    "max_tokens": 256,
    "temperature": 0.9,
    "top_p": 0.95,
    "frequency_penalty": 0.1,
    "presence_penalty": 0.1,
}

ANTH_CONN = dict(OAI_CONN, provider="anthropic", base_url="https://mock.anthropic.com", api_key="sk-ant")

SAMPLING = ("max_tokens", "temperature", "top_p", "frequency_penalty", "presence_penalty")


def sse(lines: list[str]) -> bytes:
    return "".join(f"data: {line}\n\n" for line in lines).encode()


async def collect(provider, payload=PAYLOAD):
    return [e async for e in provider.stream_chat(payload)]


def oai_provider(handler) -> OpenAICompatProvider:
    p = OpenAICompatProvider(OAI_CONN)
    p._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return p


def anth_provider(handler) -> AnthropicProvider:
    p = AnthropicProvider(ANTH_CONN)
    p._client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return p


def make_character(**overrides) -> dict:
    base = {
        "kind": "character",
        "name": "Serana",
        "tagline": "",
        "description": "A centuries-old vampire noble with a dry wit.",
        "personality": "wry, guarded, fiercely loyal",
        "scenario": "{{user}} found her sealed in an ancient crypt.",
        "greeting": "*She stirs.* Who... are you, {{user}}?",
        "alternate_greetings": [],
        "example_dialogues": "<START>\n{{user}}: Are you alright?\n{{char}}: *dusts off* Define alright.",
        "system_prompt": "",
        "post_history_instructions": "",
        "creator_notes": "",
        "tags": [],
        "creator": "",
        "character_version": "",
    }
    base.update(overrides)
    return base


def make_connection(**overrides) -> dict:
    base = {"context_size": 8192, "max_tokens": 512}
    base.update(overrides)
    return base


def make_message(role: str, text: str, position: int) -> dict:
    return {
        "id": f"m{position}",
        "role": role,
        "variants": [text],
        "active_index": 0,
        "position": position,
    }


PERSONA = {"name": "Alex", "description": "A wandering scholar."}
