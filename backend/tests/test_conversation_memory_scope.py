"""Tests for conversation-scoped memories: cascade delete and isolation."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


async def _create_character(client: AsyncClient, name: str = "Conv Memory Char") -> str:
    resp = await client.post("/characters", json={"name": name})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _create_conversation(client: AsyncClient, char_id: str, title: str) -> str:
    resp = await client.post("/conversations", json={"character_id": char_id, "title": title})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _create_memory(
    client: AsyncClient,
    char_id: str,
    title: str,
    content: str,
    *,
    conversation_id: str | None = None,
) -> str:
    payload: dict = {
        "character_id": char_id,
        "type": "semantic",
        "title": title,
        "content": content,
    }
    if conversation_id is not None:
        payload["conversation_id"] = conversation_id
    resp = await client.post(f"/characters/{char_id}/memories", json=payload)
    assert resp.status_code == 201
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_delete_conversation_cascades_memories(client: AsyncClient) -> None:
    """Deleting a conversation should also delete its scoped memories."""
    char_id = await _create_character(client, "Cascade Char")
    conv_id = await _create_conversation(client, char_id, "Will be deleted")

    # Create a memory scoped to the conversation
    mem_id = await _create_memory(
        client, char_id, "Conv memory", "Something from this conv", conversation_id=conv_id
    )

    # Verify it exists
    resp = await client.get(f"/characters/{char_id}/memories")
    assert any(m["id"] == mem_id for m in resp.json())

    # Delete the conversation
    resp = await client.delete(f"/conversations/{conv_id}")
    assert resp.status_code == 204

    # Memory should be gone (cascade delete)
    resp = await client.get(f"/characters/{char_id}/memories?include_deleted=true")
    assert not any(m["id"] == mem_id for m in resp.json())


@pytest.mark.asyncio
async def test_delete_conversation_keeps_global_memories(client: AsyncClient) -> None:
    """Global (character-level) memories without conversation_id survive conversation deletion."""
    char_id = await _create_character(client, "Global Mem Char")
    conv_id = await _create_conversation(client, char_id, "Temp conv")

    # Create a global memory (no conversation_id)
    global_mem_id = await _create_memory(client, char_id, "Global fact", "A character-level memory")
    # Create a conv-scoped memory
    conv_mem_id = await _create_memory(
        client, char_id, "Conv fact", "A conv-level memory", conversation_id=conv_id
    )

    # Delete the conversation
    resp = await client.delete(f"/conversations/{conv_id}")
    assert resp.status_code == 204

    # Global memory should survive, conv-scoped memory should be gone
    resp = await client.get(f"/characters/{char_id}/memories?include_deleted=true")
    ids = [m["id"] for m in resp.json()]
    assert global_mem_id in ids
    assert conv_mem_id not in ids


@pytest.mark.asyncio
async def test_two_conversations_have_isolated_memories(client: AsyncClient) -> None:
    """Two conversations with the same character should not share memories."""
    from app.core.repositories.memory_repository import MemoryRepository

    char_id = await _create_character(client, "Isolation Char")
    conv_a = await _create_conversation(client, char_id, "Conv A")
    conv_b = await _create_conversation(client, char_id, "Conv B")

    # Create memories for each conversation
    mem_a = await _create_memory(
        client, char_id, "Fact from A", "Only in conversation A", conversation_id=conv_a
    )
    mem_b = await _create_memory(
        client, char_id, "Fact from B", "Only in conversation B", conversation_id=conv_b
    )

    repo = MemoryRepository()

    # list_by_conversation for A should contain mem_a but NOT mem_b
    mems_a = await repo.list_by_conversation(conv_a, char_id)
    ids_a = [m.id for m in mems_a]
    assert mem_a in ids_a
    assert mem_b not in ids_a

    # list_by_conversation for B should contain mem_b but NOT mem_a
    mems_b = await repo.list_by_conversation(conv_b, char_id)
    ids_b = [m.id for m in mems_b]
    assert mem_b in ids_b
    assert mem_a not in ids_b

    await repo.close()


@pytest.mark.asyncio
async def test_global_memories_visible_in_all_conversations(client: AsyncClient) -> None:
    """Character-level memories (no conversation_id) should be visible in every conversation."""
    from app.core.repositories.memory_repository import MemoryRepository

    char_id = await _create_character(client, "Global Vis Char")
    conv_a = await _create_conversation(client, char_id, "Conv A")
    conv_b = await _create_conversation(client, char_id, "Conv B")

    # Create a global memory
    global_id = await _create_memory(client, char_id, "Global", "Shared knowledge")

    repo = MemoryRepository()

    # Both conversations should see the global memory
    mems_a = await repo.list_by_conversation(conv_a, char_id)
    assert any(m.id == global_id for m in mems_a)

    mems_b = await repo.list_by_conversation(conv_b, char_id)
    assert any(m.id == global_id for m in mems_b)

    await repo.close()
