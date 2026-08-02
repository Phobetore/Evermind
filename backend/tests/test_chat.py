"""Chat service tests with a mocked provider (no network)."""

import json
from typing import ClassVar

import pytest

from app.providers.base import ProviderEvent


class FakeProvider:
    """Yields scripted events; records the payload it received."""

    # Shared on the class on purpose: the service instantiates the provider
    # itself, so the tests have nowhere else to read the captured payload from.
    captured: ClassVar[dict] = {}

    def __init__(self, connection):
        self.connection = connection

    async def stream_chat(self, payload):
        FakeProvider.captured["payload"] = payload
        FakeProvider.captured["connection"] = self.connection
        for event in FakeProvider.script:
            yield event


@pytest.fixture()
def fake_provider(monkeypatch):
    FakeProvider.script = [
        ProviderEvent(type="delta", text="*She "),
        ProviderEvent(type="delta", text="smiles.* Hello."),
        ProviderEvent(type="done", usage={"total_tokens": 10}),
    ]
    FakeProvider.captured = {}
    monkeypatch.setattr("app.services.chat_service.get_provider", FakeProvider)
    return FakeProvider


async def setup_conversation(client, greeting="*She stirs.* Hi {{user}}."):
    char = (await client.post("/api/characters", json={"name": "Serana", "greeting": greeting})).json()
    (await client.post("/api/personas", json={"name": "Alex"})).json()
    (await client.post("/api/connections", json={
        "name": "Local", "provider": "openai-compatible",
        "base_url": "http://localhost:1234/v1", "model": "test",
    })).json()
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    return convo


def parse_sse(text: str) -> list[dict]:
    events = []
    for line in text.splitlines():
        if line.startswith("data:"):
            events.append(json.loads(line[5:].strip()))
    return events


async def send(client, convo_id, content="Hello there", mode="send"):
    resp = await client.post("/api/chat", json={
        "conversation_id": convo_id, "mode": mode, "content": content,
    })
    assert resp.status_code == 200, resp.text
    return parse_sse(resp.text)


async def test_send_persists_and_streams(client, fake_provider):
    convo = await setup_conversation(client)
    events = await send(client, convo["id"])

    types = [e["type"] for e in events]
    assert types[0] == "start"
    assert "delta" in types
    assert types[-1] == "done"

    done = events[-1]
    assert done["message"]["role"] == "assistant"
    assert done["message"]["content"] == "*She smiles.* Hello."

    messages = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    assert [m["role"] for m in messages] == ["assistant", "user", "assistant"]
    assert messages[1]["content"] == "Hello there"

    # auto title from first user message
    convos = (await client.get("/api/conversations")).json()
    assert convos[0]["title"].startswith("Hello there")

    # prompt payload used real turns including greeting
    payload = fake_provider.captured["payload"]
    assert payload.messages[0]["role"] == "assistant"
    assert payload.messages[-1] == {"role": "user", "content": "Hello there"}
    assert "Serana" in payload.system


async def test_send_without_connection_errors(client, fake_provider):
    char = (await client.post("/api/characters", json={"name": "X", "greeting": ""})).json()
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    events = await send(client, convo["id"])
    assert events[-1]["type"] == "error"
    assert "connection" in events[-1]["message"].lower()


async def test_regenerate_adds_variant(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])

    fake_provider.script = [
        ProviderEvent(type="delta", text="Second take."),
        ProviderEvent(type="done"),
    ]
    events = await send(client, convo["id"], content=None, mode="regenerate")
    assert events[-1]["type"] == "done"
    message = events[-1]["message"]
    assert message["variants"] == ["*She smiles.* Hello.", "Second take."]
    assert message["active_index"] == 1
    # history must NOT include the message being regenerated
    payload = fake_provider.captured["payload"]
    assert payload.messages[-1] == {"role": "user", "content": "Hello there"}


async def test_regenerate_after_error_creates_assistant(client, fake_provider):
    convo = await setup_conversation(client)
    fake_provider.script = [ProviderEvent(type="error", message="boom")]
    events = await send(client, convo["id"])
    assert events[-1]["type"] == "error"
    messages = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    assert [m["role"] for m in messages] == ["assistant", "user"]  # no empty assistant persisted

    fake_provider.script = [ProviderEvent(type="delta", text="Recovered."), ProviderEvent(type="done")]
    events = await send(client, convo["id"], content=None, mode="regenerate")
    assert events[-1]["message"]["content"] == "Recovered."
    messages = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    assert [m["role"] for m in messages] == ["assistant", "user", "assistant"]


async def test_regenerate_greeting_only_rejected(client, fake_provider):
    convo = await setup_conversation(client)
    events = await send(client, convo["id"], content=None, mode="regenerate")
    assert events[-1]["type"] == "error"


async def test_continue_appends_to_active_variant(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    fake_provider.script = [ProviderEvent(type="delta", text=" And more."), ProviderEvent(type="done")]
    events = await send(client, convo["id"], content=None, mode="continue")
    assert events[-1]["message"]["content"] == "*She smiles.* Hello. And more."
    # continue instruction injected as an extra user turn (not persisted)
    payload = fake_provider.captured["payload"]
    assert payload.messages[-1]["role"] == "user"
    assert "continue" in payload.messages[-1]["content"].lower()
    messages = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    assert len(messages) == 3


async def test_impersonation_trimmed(client, fake_provider):
    convo = await setup_conversation(client)
    fake_provider.script = [
        ProviderEvent(type="delta", text="Fine.\nAlex: I say something for you"),
        ProviderEvent(type="done"),
    ]
    events = await send(client, convo["id"])
    assert events[-1]["message"]["content"] == "Fine."


async def test_summarize(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    fake_provider.script = [ProviderEvent(type="delta", text="They met in a crypt."), ProviderEvent(type="done")]
    resp = await client.post(f"/api/conversations/{convo['id']}/summarize")
    assert resp.status_code == 200
    assert resp.json()["summary"] == "They met in a crypt."


async def test_auto_title_strips_rp_markup(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"], content="*I step back, torch raised.* Easy, I'm Aymeric.")
    convos = (await client.get("/api/conversations")).json()
    assert convos[0]["title"] == "Easy, I'm Aymeric."


def test_auto_title_does_not_stall_on_a_pathological_message():
    """The markup patterns are quadratic on a long run of unclosed brackets, so
    the input is truncated before they see it. Without that, a large enough first
    message pins a core for minutes."""
    import time

    from app.services.chat_service import _auto_title

    started = time.perf_counter()
    _auto_title("[" * 200_000)
    assert time.perf_counter() - started < 0.5


async def test_done_event_includes_context_and_perf(client, fake_provider):
    convo = await setup_conversation(client)
    events = await send(client, convo["id"])
    done = events[-1]
    assert done["context"]["context_size"] == 16384  # connection default
    assert done["context"]["used_tokens"] > 0
    assert done["context"]["messages_included"] >= 2
    assert "gen_seconds" in done["perf"]


async def test_impersonate_flips_roles(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    fake_provider.script = [
        ProviderEvent(type="delta", text="*Je souris.* On y va."),
        ProviderEvent(type="done"),
    ]
    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert resp.status_code == 200, resp.text
    assert resp.json()["text"] == "*Je souris.* On y va."
    payload = fake_provider.captured["payload"]
    assert "ghost-writing" in payload.system
    # character turns became "user", the player's turn became "assistant"
    assert [m["role"] for m in payload.messages] == ["user", "assistant", "user"]
    assert payload.stop == ["\nSerana:"]


async def test_narrate_and_ooc_modes(client, fake_provider):
    convo = await setup_conversation(client)
    # narration: stored raw, marked up for the model, no auto title
    resp = await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "send",
        "content": "Un orage eclate au-dessus de la crypte.", "message_mode": "narrate",
    })
    assert resp.status_code == 200
    payload = fake_provider.captured["payload"]
    assert payload.messages[-1]["content"] == "[Narration] Un orage eclate au-dessus de la crypte."
    messages = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    narration = messages[1]
    assert narration["content"] == "Un orage eclate au-dessus de la crypte."  # raw for display
    assert narration["meta"]["mode"] == "narrate"
    convos = (await client.get("/api/conversations")).json()
    assert convos[0]["title"] == ""  # narration does not become the title

    # ooc: wrapped for the model
    await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "send",
        "content": "Arrete de laisser les phrases en suspens.", "message_mode": "ooc",
    })
    payload = fake_provider.captured["payload"]
    assert payload.messages[-1]["content"] == "(OOC: Arrete de laisser les phrases en suspens.)"


def test_marker_rules_present():
    from app.prompting.defaults import DEFAULT_RP_RULES, SCENARIO_RP_RULES
    for rules in (DEFAULT_RP_RULES, SCENARIO_RP_RULES):
        assert "[Narration]" in rules
        assert "(OOC:" in rules
        assert "finish their sentences" in rules
