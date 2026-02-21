"""Tests for health and version endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health(client: AsyncClient) -> None:
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_version(client: AsyncClient) -> None:
    resp = await client.get("/version")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] == "0.1.0"
    assert body["name"] == "evermind-backend"
