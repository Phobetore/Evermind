"""Tests for message variant endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


async def _create_message(client: AsyncClient) -> tuple[str, str]:
    """Helper: create a character → conversation → message and return (conv_id, msg_id)."""
    char = await client.post("/characters", json={"name": "VariantChar"})
    cid = char.json()["id"]
    conv = await client.post("/conversations", json={"character_id": cid})
    conv_id = conv.json()["id"]
    msg = await client.post(
        f"/conversations/{conv_id}/messages",
        json={"conversation_id": conv_id, "role": "assistant", "content": "Original reply"},
    )
    return conv_id, msg.json()["id"]


@pytest.mark.asyncio
async def test_create_and_list_variants(client: AsyncClient) -> None:
    _, msg_id = await _create_message(client)

    # Create two variants
    resp1 = await client.post(
        f"/messages/{msg_id}/variants",
        json={"message_id": msg_id, "content": "Variant A", "score": 0.9},
    )
    assert resp1.status_code == 201
    body1 = resp1.json()
    assert body1["message_id"] == msg_id
    assert body1["content"] == "Variant A"
    assert body1["score"] == 0.9
    assert body1["is_selected"] is False

    resp2 = await client.post(
        f"/messages/{msg_id}/variants",
        json={"message_id": msg_id, "content": "Variant B"},
    )
    assert resp2.status_code == 201

    # List variants
    resp = await client.get(f"/messages/{msg_id}/variants")
    assert resp.status_code == 200
    variants = resp.json()
    assert len(variants) == 2


@pytest.mark.asyncio
async def test_select_variant(client: AsyncClient) -> None:
    _, msg_id = await _create_message(client)

    v1 = await client.post(
        f"/messages/{msg_id}/variants",
        json={"message_id": msg_id, "content": "V1", "is_selected": True},
    )
    v2 = await client.post(
        f"/messages/{msg_id}/variants",
        json={"message_id": msg_id, "content": "V2"},
    )
    vid1 = v1.json()["id"]
    vid2 = v2.json()["id"]

    # Select V2
    resp = await client.post(f"/messages/{msg_id}/variants/{vid2}/select")
    assert resp.status_code == 200
    assert resp.json()["is_selected"] is True

    # V1 should be deselected
    listed = await client.get(f"/messages/{msg_id}/variants")
    for v in listed.json():
        if v["id"] == vid1:
            assert v["is_selected"] is False
        elif v["id"] == vid2:
            assert v["is_selected"] is True


@pytest.mark.asyncio
async def test_select_variant_not_found(client: AsyncClient) -> None:
    _, msg_id = await _create_message(client)
    resp = await client.post(f"/messages/{msg_id}/variants/nonexistent/select")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_variant(client: AsyncClient) -> None:
    _, msg_id = await _create_message(client)
    v = await client.post(
        f"/messages/{msg_id}/variants",
        json={"message_id": msg_id, "content": "ToDelete"},
    )
    vid = v.json()["id"]

    resp = await client.delete(f"/messages/{msg_id}/variants/{vid}")
    assert resp.status_code == 204

    # Verify gone
    listed = await client.get(f"/messages/{msg_id}/variants")
    assert all(item["id"] != vid for item in listed.json())


@pytest.mark.asyncio
async def test_delete_variant_not_found(client: AsyncClient) -> None:
    _, msg_id = await _create_message(client)
    resp = await client.delete(f"/messages/{msg_id}/variants/nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_create_variant_message_id_mismatch(client: AsyncClient) -> None:
    _, msg_id = await _create_message(client)
    resp = await client.post(
        f"/messages/{msg_id}/variants",
        json={"message_id": "wrong-id", "content": "Bad variant"},
    )
    assert resp.status_code == 400
