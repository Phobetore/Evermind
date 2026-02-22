"""Tests for memory rebuild endpoint and memory_seed import."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_memory_rebuild_clears_memories(client: AsyncClient) -> None:
    """POST /characters/{id}/memories/rebuild should soft-delete existing memories."""
    # Create a character
    resp = await client.post("/characters", json={"name": "RebuildChar"})
    assert resp.status_code == 201
    char_id = resp.json()["id"]

    # Create a memory for the character
    resp = await client.post(
        f"/characters/{char_id}/memories",
        json={
            "character_id": char_id,
            "type": "semantic",
            "title": "Test memory",
            "content": "Something worth remembering",
            "importance": 0.7,
            "confidence": 0.9,
        },
    )
    assert resp.status_code == 201

    # Verify the memory exists
    resp = await client.get(f"/characters/{char_id}/memories")
    assert resp.status_code == 200
    assert len(resp.json()) == 1

    # Rebuild (soft-delete all)
    resp = await client.post(f"/characters/{char_id}/memories/rebuild")
    assert resp.status_code == 202
    data = resp.json()
    assert data["status"] == "rebuild_scheduled"
    assert data["memories_cleared"] == 1

    # Verify memories are now soft-deleted (not visible without include_deleted)
    resp = await client.get(f"/characters/{char_id}/memories")
    assert resp.status_code == 200
    assert len(resp.json()) == 0

    # But still visible with include_deleted=true
    resp = await client.get(f"/characters/{char_id}/memories?include_deleted=true")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


@pytest.mark.asyncio
async def test_memory_rebuild_empty_character(client: AsyncClient) -> None:
    """Rebuild on character with no memories should return 0 cleared."""
    resp = await client.post("/characters", json={"name": "EmptyChar"})
    assert resp.status_code == 201
    char_id = resp.json()["id"]

    resp = await client.post(f"/characters/{char_id}/memories/rebuild")
    assert resp.status_code == 202
    assert resp.json()["memories_cleared"] == 0


@pytest.mark.asyncio
async def test_import_character_creates_memory_seeds(client: AsyncClient) -> None:
    """Importing a character with memory_seed should create Memory records."""
    payload = {
        "version": "1",
        "character": {
            "name": "SeededChar",
            "summary": "A character with initial memories",
            "memory_seed": [
                {"content": "Loves hiking in the mountains", "type": "semantic", "importance": 0.8},
                {"content": "Had a bad experience with dogs", "type": "episodic", "importance": 0.6},
            ],
        },
    }
    resp = await client.post("/characters/import", json=payload)
    assert resp.status_code == 201
    char_id = resp.json()["id"]

    # Check that memory records were created
    resp = await client.get(f"/characters/{char_id}/memories")
    assert resp.status_code == 200
    memories = resp.json()
    assert len(memories) == 2

    # Verify the memory contents
    contents = {m["content"] for m in memories}
    assert "Loves hiking in the mountains" in contents
    assert "Had a bad experience with dogs" in contents

    # Verify types are correct
    types = {m["content"]: m["type"] for m in memories}
    assert types["Loves hiking in the mountains"] == "semantic"
    assert types["Had a bad experience with dogs"] == "episodic"


@pytest.mark.asyncio
async def test_import_character_empty_memory_seed(client: AsyncClient) -> None:
    """Import with empty memory_seed should create no memories."""
    payload = {
        "version": "1",
        "character": {
            "name": "NoSeedChar",
            "memory_seed": [],
        },
    }
    resp = await client.post("/characters/import", json=payload)
    assert resp.status_code == 201
    char_id = resp.json()["id"]

    resp = await client.get(f"/characters/{char_id}/memories")
    assert resp.status_code == 200
    assert len(resp.json()) == 0


@pytest.mark.asyncio
async def test_import_character_skips_empty_seed_content(client: AsyncClient) -> None:
    """Empty content in memory_seed should be skipped."""
    payload = {
        "version": "1",
        "character": {
            "name": "PartialSeed",
            "memory_seed": [
                {"content": "Valid memory", "type": "semantic", "importance": 0.7},
                {"content": "", "type": "semantic", "importance": 0.5},
            ],
        },
    }
    resp = await client.post("/characters/import", json=payload)
    assert resp.status_code == 201
    char_id = resp.json()["id"]

    resp = await client.get(f"/characters/{char_id}/memories")
    assert resp.status_code == 200
    # Only the non-empty seed should create a memory
    assert len(resp.json()) == 1
