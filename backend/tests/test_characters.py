"""Tests for character CRUD endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_character(client: AsyncClient) -> None:
    resp = await client.post("/characters", json={"name": "Alice"})
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Alice"
    assert body["id"]
    assert body["tags"] == []


@pytest.mark.asyncio
async def test_list_characters(client: AsyncClient) -> None:
    await client.post("/characters", json={"name": "Bob"})
    resp = await client.get("/characters")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
    assert any(c["name"] == "Bob" for c in resp.json())


@pytest.mark.asyncio
async def test_get_character(client: AsyncClient) -> None:
    create_resp = await client.post("/characters", json={"name": "Charlie"})
    cid = create_resp.json()["id"]
    resp = await client.get(f"/characters/{cid}")
    assert resp.status_code == 200
    assert resp.json()["name"] == "Charlie"


@pytest.mark.asyncio
async def test_get_character_not_found(client: AsyncClient) -> None:
    resp = await client.get("/characters/nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_update_character(client: AsyncClient) -> None:
    create_resp = await client.post("/characters", json={"name": "Diana", "summary": "Original"})
    cid = create_resp.json()["id"]
    resp = await client.put(f"/characters/{cid}", json={"summary": "Updated"})
    assert resp.status_code == 200
    assert resp.json()["summary"] == "Updated"
    assert resp.json()["name"] == "Diana"


@pytest.mark.asyncio
async def test_delete_character(client: AsyncClient) -> None:
    create_resp = await client.post("/characters", json={"name": "Eve"})
    cid = create_resp.json()["id"]
    resp = await client.delete(f"/characters/{cid}")
    assert resp.status_code == 204
    # Verify gone
    resp = await client.get(f"/characters/{cid}")
    assert resp.status_code == 404
