"""Tests for listing all conversations (without character_id filter)."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_list_all_conversations(client: AsyncClient) -> None:
    """GET /conversations without character_id should return all conversations."""
    # Create a character
    char_resp = await client.post("/characters", json={"name": "ListAll Hero"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    # Create two conversations
    for title in ["Conv A", "Conv B"]:
        r = await client.post(
            "/conversations",
            json={"character_id": char_id, "title": title},
        )
        assert r.status_code == 201

    # List all (no character_id param)
    resp = await client.get("/conversations")
    assert resp.status_code == 200
    convs = resp.json()
    assert len(convs) >= 2
    titles = {c["title"] for c in convs}
    assert "Conv A" in titles
    assert "Conv B" in titles


@pytest.mark.asyncio
async def test_list_conversations_filter_by_character(client: AsyncClient) -> None:
    """GET /conversations?character_id=… should only return that character's conversations."""
    char1 = await client.post("/characters", json={"name": "Char One"})
    char2 = await client.post("/characters", json={"name": "Char Two"})

    await client.post(
        "/conversations",
        json={"character_id": char1.json()["id"], "title": "C1 conv"},
    )
    await client.post(
        "/conversations",
        json={"character_id": char2.json()["id"], "title": "C2 conv"},
    )

    resp = await client.get(f"/conversations?character_id={char1.json()['id']}")
    assert resp.status_code == 200
    convs = resp.json()
    assert all(c["character_id"] == char1.json()["id"] for c in convs)
