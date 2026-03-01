"""Tests for message endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


async def _create_conversation(client: AsyncClient) -> tuple[str, str]:
    """Helper: create a character + conversation, return (character_id, conversation_id)."""
    char_resp = await client.post("/characters", json={"name": "Msg Test Char"})
    char_id = char_resp.json()["id"]
    conv_resp = await client.post(
        "/conversations", json={"character_id": char_id, "title": "Msg Conv"}
    )
    conv_id = conv_resp.json()["id"]
    return char_id, conv_id


@pytest.mark.asyncio
async def test_create_and_list_messages(client: AsyncClient) -> None:
    _, conv_id = await _create_conversation(client)

    # Create a user message
    resp = await client.post(
        f"/conversations/{conv_id}/messages",
        json={"conversation_id": conv_id, "role": "user", "content": "Hello there!"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["role"] == "user"
    assert body["content"] == "Hello there!"

    # List messages
    resp = await client.get(f"/conversations/{conv_id}/messages")
    assert resp.status_code == 200
    messages = resp.json()
    assert len(messages) >= 1
    assert messages[0]["content"] == "Hello there!"


@pytest.mark.asyncio
async def test_delete_last_assistant_message(client: AsyncClient) -> None:
    """delete_last_assistant_message removes only the latest assistant reply."""
    from app.core.repositories.message_repository import MessageRepository
    from app.models.message import MessageCreate

    _, conv_id = await _create_conversation(client)
    repo = MessageRepository()

    # Seed a user message + assistant reply
    await repo.create(MessageCreate(conversation_id=conv_id, role="user", content="Hi"))
    await repo.create(
        MessageCreate(conversation_id=conv_id, role="assistant", content="Hello!")
    )

    msgs_before = await repo.list_by_conversation(conv_id)
    assert len(msgs_before) == 2

    await repo.delete_last_assistant_message(conv_id)

    msgs_after = await repo.list_by_conversation(conv_id)
    assert len(msgs_after) == 1
    assert msgs_after[0].role == "user"
