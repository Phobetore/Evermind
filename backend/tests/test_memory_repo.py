"""Tests for enhanced MemoryRepository methods (update_importance, merge)."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


async def _create_character(client: AsyncClient, name: str = "Repo Test Char") -> str:
    resp = await client.post("/characters", json={"name": name})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _create_memory(
    client: AsyncClient,
    char_id: str,
    title: str,
    content: str,
    mem_type: str = "semantic",
) -> str:
    resp = await client.post(
        f"/characters/{char_id}/memories",
        json={
            "character_id": char_id,
            "type": mem_type,
            "title": title,
            "content": content,
        },
    )
    assert resp.status_code == 201
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_memory_update_importance(client: AsyncClient) -> None:
    """The update_importance repository method should change scores."""
    from app.core.repositories.memory_repository import MemoryRepository

    char_id = await _create_character(client, "Importance Char")
    mem_id = await _create_memory(client, char_id, "A fact", "Some fact content")

    repo = MemoryRepository()
    ok = await repo.update_importance(mem_id, importance=0.95, confidence=0.9)
    assert ok is True

    memory = await repo.get(mem_id)
    assert memory is not None
    assert memory.importance == pytest.approx(0.95)
    assert memory.confidence == pytest.approx(0.9)
    await repo.close()


@pytest.mark.asyncio
async def test_memory_merge(client: AsyncClient) -> None:
    """Merging two memories should update target and soft-delete source."""
    from app.core.repositories.memory_repository import MemoryRepository

    char_id = await _create_character(client, "Merge Char")
    source_id = await _create_memory(client, char_id, "Old fact", "User has a dog")
    target_id = await _create_memory(client, char_id, "New fact", "User has a cat")

    repo = MemoryRepository()
    result = await repo.merge(source_id, target_id, "User has a dog and a cat")
    assert result is not None
    assert result.content == "User has a dog and a cat"

    # Source should be soft-deleted
    source = await repo.get(source_id)
    assert source is not None
    assert source.is_deleted is True
    await repo.close()


@pytest.mark.asyncio
async def test_memory_merge_nonexistent_target(client: AsyncClient) -> None:
    """Merging into a nonexistent target should return None."""
    from app.core.repositories.memory_repository import MemoryRepository

    repo = MemoryRepository()
    result = await repo.merge("nonexistent", "also-nonexistent", "content")
    assert result is None
    await repo.close()
