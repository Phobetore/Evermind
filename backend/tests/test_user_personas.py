"""Tests for user persona CRUD endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_user_persona(client: AsyncClient) -> None:
    resp = await client.post(
        "/user_personas",
        json={
            "name": "Alice",
            "age": "25",
            "physical_description": "Tall with brown hair",
            "personality": "Friendly and outgoing",
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Alice"
    assert body["age"] == "25"
    assert body["physical_description"] == "Tall with brown hair"
    assert body["personality"] == "Friendly and outgoing"
    assert body["avatar_path"] == ""
    assert "id" in body


@pytest.mark.asyncio
async def test_list_user_personas(client: AsyncClient) -> None:
    await client.post("/user_personas", json={"name": "Persona A"})
    await client.post("/user_personas", json={"name": "Persona B"})
    resp = await client.get("/user_personas")
    assert resp.status_code == 200
    assert len(resp.json()) >= 2


@pytest.mark.asyncio
async def test_get_user_persona(client: AsyncClient) -> None:
    create_resp = await client.post("/user_personas", json={"name": "Bob"})
    persona_id = create_resp.json()["id"]
    resp = await client.get(f"/user_personas/{persona_id}")
    assert resp.status_code == 200
    assert resp.json()["name"] == "Bob"


@pytest.mark.asyncio
async def test_get_nonexistent_persona(client: AsyncClient) -> None:
    resp = await client.get("/user_personas/nonexistent-id")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_update_user_persona(client: AsyncClient) -> None:
    create_resp = await client.post("/user_personas", json={"name": "Charlie"})
    persona_id = create_resp.json()["id"]
    resp = await client.patch(
        f"/user_personas/{persona_id}",
        json={"age": "30", "physical_description": "Short with red hair"},
    )
    assert resp.status_code == 200
    assert resp.json()["age"] == "30"
    assert resp.json()["physical_description"] == "Short with red hair"
    assert resp.json()["name"] == "Charlie"  # unchanged


@pytest.mark.asyncio
async def test_delete_user_persona(client: AsyncClient) -> None:
    create_resp = await client.post("/user_personas", json={"name": "Dave"})
    persona_id = create_resp.json()["id"]
    resp = await client.delete(f"/user_personas/{persona_id}")
    assert resp.status_code == 204
    resp = await client.get(f"/user_personas/{persona_id}")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_create_conversation_with_persona(client: AsyncClient) -> None:
    char_resp = await client.post("/characters", json={"name": "Test Char"})
    char_id = char_resp.json()["id"]
    persona_resp = await client.post("/user_personas", json={"name": "Eve"})
    persona_id = persona_resp.json()["id"]

    resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "With persona", "user_persona_id": persona_id},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["user_persona_id"] == persona_id


@pytest.mark.asyncio
async def test_create_conversation_without_persona(client: AsyncClient) -> None:
    char_resp = await client.post("/characters", json={"name": "Test Char2"})
    char_id = char_resp.json()["id"]

    resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "No persona"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["user_persona_id"] is None


@pytest.mark.asyncio
async def test_persona_name_required(client: AsyncClient) -> None:
    resp = await client.post("/user_personas", json={"name": ""})
    assert resp.status_code == 422
