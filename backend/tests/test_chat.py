"""Chat service tests with a mocked provider (no network)."""

import pytest

from app.providers.base import ProviderError, ProviderEvent
from app.services import turns

from .conftest import FakeProvider, messages_of, send, setup_conversation


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


async def test_send_persists_the_message_and_its_reply(client, fake_provider):
    convo = await setup_conversation(client)
    resp = await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "send", "content": "Hello there"})

    # Answered once the message is saved, with the message as it is saved.
    assert resp.status_code == 200
    asked = resp.json()["user_message"]
    assert (asked["role"], asked["content"], asked["meta"]) == ("user", "Hello there", {"unanswered": True})
    turn = await turns.running_for(convo["id"])
    if turn:
        await turn.finished.wait()

    messages = await messages_of(client, convo["id"])
    assert [m["role"] for m in messages] == ["assistant", "user", "assistant"]
    assert messages[1]["id"] == asked["id"]
    assert messages[2]["content"] == "*She smiles.* Hello."
    assert "unanswered" not in messages[1]["meta"]

    # auto title from first user message
    convos = (await client.get("/api/conversations")).json()
    assert convos[0]["title"].startswith("Hello there")

    # prompt payload used real turns including greeting
    payload = fake_provider.captured["payload"]
    assert payload.messages[0]["role"] == "assistant"
    assert payload.messages[-1] == {"role": "user", "content": "Hello there"}
    assert "Serana" in payload.system


async def test_send_without_connection_is_refused_and_keeps_nothing(client, fake_provider):
    char = (await client.post("/api/characters", json={"name": "X", "greeting": ""})).json()
    convo = (await client.post("/api/conversations", json={"character_id": char["id"]})).json()
    resp = await client.post("/api/chat", json={
        "conversation_id": convo["id"], "mode": "send", "content": "Hello there"})
    assert resp.status_code == 400
    assert resp.json()["kind"] == "no_connection"
    assert await messages_of(client, convo["id"]) == []


async def test_regenerate_adds_variant(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])

    fake_provider.script = [
        ProviderEvent(type="delta", text="Second take."),
        ProviderEvent(type="done"),
    ]
    assert await send(client, convo["id"], content=None, mode="regenerate") is None
    message = (await messages_of(client, convo["id"]))[-1]
    assert message["variants"] == ["*She smiles.* Hello.", "Second take."]
    assert message["active_index"] == 1
    # history must NOT include the message being regenerated
    payload = fake_provider.captured["payload"]
    assert payload.messages[-1] == {"role": "user", "content": "Hello there"}


async def test_regenerate_after_error_creates_assistant(client, fake_provider):
    convo = await setup_conversation(client)
    fake_provider.script = [ProviderError("boom")]
    assert (await send(client, convo["id"]))["kind"] == "model_error"
    messages = await messages_of(client, convo["id"])
    assert [m["role"] for m in messages] == ["assistant", "user"]  # no empty assistant persisted

    fake_provider.script = [ProviderEvent(type="delta", text="Recovered."), ProviderEvent(type="done")]
    assert await send(client, convo["id"], content=None, mode="regenerate") is None
    messages = await messages_of(client, convo["id"])
    assert [m["role"] for m in messages] == ["assistant", "user", "assistant"]
    assert messages[-1]["content"] == "Recovered."


async def test_regenerate_greeting_only_rejected(client, fake_provider):
    convo = await setup_conversation(client)
    resp = await client.post("/api/chat", json={"conversation_id": convo["id"], "mode": "regenerate"})
    assert resp.status_code == 400
    assert resp.json()["kind"] == "nothing_to_regenerate"


async def test_continue_appends_to_active_variant(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    fake_provider.script = [ProviderEvent(type="delta", text=" And more."), ProviderEvent(type="done")]
    await send(client, convo["id"], content=None, mode="continue")
    assert (await messages_of(client, convo["id"]))[-1]["content"] == "*She smiles.* Hello. And more."
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
    await send(client, convo["id"])
    assert (await messages_of(client, convo["id"]))[-1]["content"] == "Fine."


async def test_the_thinking_a_model_writes_before_its_reply_is_not_saved(client, fake_provider):
    convo = await setup_conversation(client)
    fake_provider.script = [
        ProviderEvent(type="delta", text="<think>She should "),
        ProviderEvent(type="delta", text="smile.</think>\n\n*She smiles.*"),
        ProviderEvent(type="done"),
    ]
    await send(client, convo["id"])
    assert (await messages_of(client, convo["id"]))[-1]["content"] == "*She smiles.*"


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


async def test_a_reply_says_what_its_prompt_held_and_how_fast_it_came(client, fake_provider):
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    meta = (await messages_of(client, convo["id"]))[-1]["meta"]
    assert meta["context"]["context_size"] == 16384  # connection default
    assert meta["context"]["used_tokens"] > 0
    assert meta["context"]["messages_included"] >= 2
    assert "gen_seconds" in meta["perf"]


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


async def test_impersonate_prompt_holds_the_persona_and_the_story_so_far(client, fake_provider):
    first = await setup_conversation(client, greeting="*She stirs.*")
    persona = (await client.post("/api/personas", json={
        "name": "Marin", "description": "A courier with a limp."})).json()
    convo = (await client.post("/api/conversations", json={
        "character_id": first["character_id"], "persona_id": persona["id"]})).json()
    await client.patch(f"/api/conversations/{convo['id']}", json={"summary": "They met in a crypt."})
    await send(client, convo["id"])
    fake_provider.script = [ProviderEvent(type="delta", text="*Je souris.*"),
                            ProviderEvent(type="done")]

    resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")

    assert resp.status_code == 200, resp.text
    payload = fake_provider.captured["payload"]
    assert payload.system.startswith("You are ghost-writing the PLAYER's next message")
    assert "The player plays Marin; their partner plays Serana." in payload.system
    assert payload.system.endswith(
        "ABOUT Marin: A courier with a limp.\n\nSTORY SO FAR: They met in a crypt.")
    # The chat as the model sees it: the character's turns are the "user" ones.
    assert [(m["role"], m["content"]) for m in payload.messages] == [
        ("user", "*She stirs.*"),
        ("assistant", "Hello there"),
        ("user", "*She smiles.* Hello."),
    ]


async def test_impersonate_gives_no_share_of_the_chat_to_the_facts(client, fake_provider):
    """The facts are not in the prompt that ghost-writes the message: they take none of its window."""
    convo = await setup_conversation(client)
    connection = (await client.get("/api/connections")).json()[0]
    await client.put(f"/api/connections/{connection['id']}",
                     json={**connection, "context_size": 2048, "max_tokens": 16})
    for _ in range(4):
        fake_provider.script = [ProviderEvent(type="delta", text="word " * 60),
                                ProviderEvent(type="done")]
        await send(client, convo["id"], content="word " * 60)

    async def messages_read():
        fake_provider.script = [ProviderEvent(type="delta", text="*Je souris.*"),
                                ProviderEvent(type="done")]
        resp = await client.post(f"/api/conversations/{convo['id']}/impersonate")
        assert resp.status_code == 200, resp.text
        return len(fake_provider.captured["payload"].messages)

    whole_chat = await messages_read()
    assert whole_chat == 9  # the greeting and four turns
    await client.post(f"/api/conversations/{convo['id']}/memories",
                      json={"content": "Serana owes Alex a boot. " * 30, "is_pinned": True})
    assert await messages_read() == whole_chat


async def test_narrate_and_ooc_modes(client, fake_provider):
    convo = await setup_conversation(client)
    # narration: stored raw, marked up for the model, no auto title
    await send(client, convo["id"], content="Un orage eclate au-dessus de la crypte.",
               message_mode="narrate")
    payload = fake_provider.captured["payload"]
    assert payload.messages[-1]["content"] == "[Narration] Un orage eclate au-dessus de la crypte."
    messages = (await client.get(f"/api/conversations/{convo['id']}")).json()["messages"]
    narration = messages[1]
    assert narration["content"] == "Un orage eclate au-dessus de la crypte."  # raw for display
    assert narration["meta"]["mode"] == "narrate"
    convos = (await client.get("/api/conversations")).json()
    assert convos[0]["title"] == ""  # narration does not become the title

    # ooc: wrapped for the model
    await send(client, convo["id"], content="Arrete de laisser les phrases en suspens.",
               message_mode="ooc")
    payload = fake_provider.captured["payload"]
    assert payload.messages[-1]["content"] == "(OOC: Arrete de laisser les phrases en suspens.)"


def test_marker_rules_present():
    from app.prompting.defaults import DEFAULT_RP_RULES, SCENARIO_RP_RULES
    for rules in (DEFAULT_RP_RULES, SCENARIO_RP_RULES):
        assert "[Narration]" in rules
        assert "(OOC:" in rules
        assert "finish their sentences" in rules
