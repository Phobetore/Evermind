"""Tests for conversation first_message auto-insertion and GET endpoint."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_conversation_auto_first_message(client: AsyncClient) -> None:
    """Creating a conversation for a character with a first_message should auto-insert it."""
    # Create a character with a first_message
    char_resp = await client.post(
        "/characters",
        json={"name": "Greeter", "first_message": "Hello, welcome to my world!"},
    )
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    # Create conversation
    conv_resp = await client.post(
        "/conversations", json={"character_id": char_id, "title": "Greeting conv"}
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    # List messages — should contain the first_message
    msgs_resp = await client.get(f"/conversations/{conv_id}/messages")
    assert msgs_resp.status_code == 200
    messages = msgs_resp.json()
    assert len(messages) == 1
    assert messages[0]["role"] == "assistant"
    assert messages[0]["content"] == "Hello, welcome to my world!"


@pytest.mark.asyncio
async def test_create_conversation_no_first_message(client: AsyncClient) -> None:
    """Creating a conversation for a character without first_message should not insert any message."""
    char_resp = await client.post("/characters", json={"name": "Silent"})
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations", json={"character_id": char_id, "title": "Silent conv"}
    )
    conv_id = conv_resp.json()["id"]

    msgs_resp = await client.get(f"/conversations/{conv_id}/messages")
    messages = msgs_resp.json()
    assert len(messages) == 0


@pytest.mark.asyncio
async def test_create_conversation_invalid_character(client: AsyncClient) -> None:
    """Creating a conversation for a non-existent character should return 404."""
    resp = await client.post(
        "/conversations",
        json={"character_id": "nonexistent-id", "title": "No such char"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_conversation(client: AsyncClient) -> None:
    """GET /conversations/{id} should return the conversation."""
    char_resp = await client.post("/characters", json={"name": "GetTest"})
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations", json={"character_id": char_id, "title": "Fetch me"}
    )
    conv_id = conv_resp.json()["id"]

    resp = await client.get(f"/conversations/{conv_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == conv_id
    assert body["title"] == "Fetch me"
    assert body["character_id"] == char_id
