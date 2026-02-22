"""Tests for the /models/status endpoint."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_models_status_returns_servers(client: AsyncClient) -> None:
    """GET /models/status should return a dict with configured server entries."""
    resp = await client.get("/models/status")
    assert resp.status_code == 200
    body = resp.json()
    assert "servers" in body
    # Each configured server should appear (chat, memory, judge from config.yaml)
    servers = body["servers"]
    assert isinstance(servers, dict)
    for info in servers.values():
        assert "port" in info
        assert info["status"] in ("ok", "loading", "unavailable")
