"""Tests for model manager and models/profiles endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


# --- Model Manager / Models endpoints ---


@pytest.mark.asyncio
async def test_models_status_returns_servers(client: AsyncClient) -> None:
    """GET /models/status should return configured server entries."""
    resp = await client.get("/models/status")
    assert resp.status_code == 200
    body = resp.json()
    assert "servers" in body
    servers = body["servers"]
    assert isinstance(servers, dict)
    for info in servers.values():
        assert "port" in info
        assert "model_path" in info
        assert info["status"] in ("ok", "loading", "unavailable")


@pytest.mark.asyncio
async def test_restart_unknown_server(client: AsyncClient) -> None:
    """POST /models/restart with an unknown name should return 404."""
    resp = await client.post("/models/restart?server_name=nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_restart_known_server(client: AsyncClient) -> None:
    """POST /models/restart for a configured server should return a status."""
    resp = await client.post("/models/restart?server_name=chat")
    assert resp.status_code == 200
    body = resp.json()
    assert body["server"] == "chat"
    assert "status" in body


# --- Profiles endpoints ---


@pytest.mark.asyncio
async def test_list_profiles(client: AsyncClient) -> None:
    """GET /profiles should return all configured profiles."""
    resp = await client.get("/profiles")
    assert resp.status_code == 200
    profiles = resp.json()
    assert isinstance(profiles, list)
    ids = [p["id"] for p in profiles]
    assert "balanced" in ids
    assert "fast" in ids


@pytest.mark.asyncio
async def test_update_profile_best_of_n(client: AsyncClient) -> None:
    """PUT /profiles/balanced should update best_of_n."""
    resp = await client.put("/profiles/balanced", json={"best_of_n": 5})
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == "balanced"
    assert body["best_of_n"] == 5

    # Verify the change persists in the list endpoint
    resp = await client.get("/profiles")
    balanced = next(p for p in resp.json() if p["id"] == "balanced")
    assert balanced["best_of_n"] == 5


@pytest.mark.asyncio
async def test_update_profile_self_refine(client: AsyncClient) -> None:
    """PUT /profiles/fast should toggle self_refine."""
    resp = await client.put("/profiles/fast", json={"self_refine": True})
    assert resp.status_code == 200
    assert resp.json()["self_refine"] is True


@pytest.mark.asyncio
async def test_update_profile_not_found(client: AsyncClient) -> None:
    """PUT /profiles/nonexistent should return 404."""
    resp = await client.put("/profiles/nonexistent", json={"best_of_n": 1})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_update_profile_validation(client: AsyncClient) -> None:
    """PUT /profiles/balanced with out-of-range best_of_n should return 422."""
    resp = await client.put("/profiles/balanced", json={"best_of_n": 0})
    assert resp.status_code == 422
