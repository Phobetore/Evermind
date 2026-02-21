"""Tests for conversation CRUD endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_conversation(client: AsyncClient) -> None:
    # Create a character first
    char_resp = await client.post("/characters", json={"name": "Test Char"})
    char_id = char_resp.json()["id"]

    resp = await client.post(
        "/conversations", json={"character_id": char_id, "title": "Hello"}
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["character_id"] == char_id
    assert body["title"] == "Hello"


@pytest.mark.asyncio
async def test_list_conversations_by_character(client: AsyncClient) -> None:
    char_resp = await client.post("/characters", json={"name": "Char A"})
    char_id = char_resp.json()["id"]
    await client.post("/conversations", json={"character_id": char_id, "title": "Conv 1"})
    await client.post("/conversations", json={"character_id": char_id, "title": "Conv 2"})

    resp = await client.get(f"/conversations?character_id={char_id}")
    assert resp.status_code == 200
    assert len(resp.json()) >= 2


@pytest.mark.asyncio
async def test_delete_conversation(client: AsyncClient) -> None:
    char_resp = await client.post("/characters", json={"name": "Char B"})
    char_id = char_resp.json()["id"]
    conv_resp = await client.post(
        "/conversations", json={"character_id": char_id, "title": "To delete"}
    )
    conv_id = conv_resp.json()["id"]

    resp = await client.delete(f"/conversations/{conv_id}")
    assert resp.status_code == 204

    resp = await client.get(f"/conversations/{conv_id}")
    assert resp.status_code == 404
