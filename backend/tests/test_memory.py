"""Tests for memory and world state endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


async def _create_character(client: AsyncClient, name: str = "Memory Test Char") -> str:
    """Helper: create a character and return its id."""
    resp = await client.post("/characters", json={"name": name})
    assert resp.status_code == 201
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_create_and_list_memories(client: AsyncClient) -> None:
    char_id = await _create_character(client)

    # Create a memory
    resp = await client.post(
        f"/characters/{char_id}/memories",
        json={
            "character_id": char_id,
            "type": "semantic",
            "title": "User likes cats",
            "content": "The user mentioned they have two cats named Luna and Milo.",
            "entities": ["User", "Luna", "Milo"],
            "tags": ["pets", "cats"],
            "importance": 0.7,
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["type"] == "semantic"
    assert body["title"] == "User likes cats"
    assert body["importance"] == 0.7
    assert body["is_pinned"] is False
    assert body["is_deleted"] is False

    # List memories
    resp = await client.get(f"/characters/{char_id}/memories")
    assert resp.status_code == 200
    memories = resp.json()
    assert len(memories) == 1
    assert memories[0]["title"] == "User likes cats"


@pytest.mark.asyncio
async def test_memory_filter_by_type(client: AsyncClient) -> None:
    char_id = await _create_character(client, "Filter Char")

    # Create semantic + episodic memories
    await client.post(
        f"/characters/{char_id}/memories",
        json={
            "character_id": char_id,
            "type": "semantic",
            "title": "Fact",
            "content": "A known fact.",
        },
    )
    await client.post(
        f"/characters/{char_id}/memories",
        json={
            "character_id": char_id,
            "type": "episodic",
            "title": "Event",
            "content": "Something that happened.",
        },
    )

    # Filter by type
    resp = await client.get(f"/characters/{char_id}/memories?type=semantic")
    assert resp.status_code == 200
    assert len(resp.json()) == 1
    assert resp.json()[0]["type"] == "semantic"


@pytest.mark.asyncio
async def test_memory_soft_delete(client: AsyncClient) -> None:
    char_id = await _create_character(client, "Delete Char")

    resp = await client.post(
        f"/characters/{char_id}/memories",
        json={
            "character_id": char_id,
            "type": "semantic",
            "title": "To forget",
            "content": "This will be forgotten.",
        },
    )
    memory_id = resp.json()["id"]

    # Forget it
    resp = await client.post(
        f"/characters/{char_id}/memories/forget?memory_id={memory_id}"
    )
    assert resp.status_code == 200

    # Should not appear in normal list
    resp = await client.get(f"/characters/{char_id}/memories")
    assert len(resp.json()) == 0

    # Should appear with include_deleted
    resp = await client.get(f"/characters/{char_id}/memories?include_deleted=true")
    assert len(resp.json()) == 1


@pytest.mark.asyncio
async def test_memory_pin_unpin(client: AsyncClient) -> None:
    char_id = await _create_character(client, "Pin Char")

    resp = await client.post(
        f"/characters/{char_id}/memories",
        json={
            "character_id": char_id,
            "type": "semantic",
            "title": "Important",
            "content": "Very important memory.",
        },
    )
    memory_id = resp.json()["id"]

    # Pin
    resp = await client.post(f"/characters/{char_id}/memories/{memory_id}/pin")
    assert resp.status_code == 200

    # Unpin
    resp = await client.post(f"/characters/{char_id}/memories/{memory_id}/unpin")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_world_state_crud(client: AsyncClient) -> None:
    char_id = await _create_character(client, "World Char")

    # Initially no world state
    resp = await client.get(f"/characters/{char_id}/world_state")
    assert resp.status_code == 200
    assert resp.json() is None

    # Create world state
    state = {
        "location": "Forest clearing",
        "relationship_state": "friendly",
        "active_goals": ["Find the lost amulet"],
    }
    resp = await client.put(
        f"/characters/{char_id}/world_state",
        json={"state": state},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["character_id"] == char_id
    assert body["state"]["location"] == "Forest clearing"

    # Update world state
    state["location"] = "Mountain pass"
    resp = await client.put(
        f"/characters/{char_id}/world_state",
        json={"state": state},
    )
    assert resp.status_code == 200
    assert resp.json()["state"]["location"] == "Mountain pass"
