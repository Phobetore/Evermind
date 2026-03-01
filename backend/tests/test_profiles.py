"""Tests for profiles endpoint."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_list_profiles(client: AsyncClient) -> None:
    resp = await client.get("/profiles")
    assert resp.status_code == 200
    profiles = resp.json()
    assert isinstance(profiles, list)
    # config.yaml has at least balanced, max_quality, fast, test
    ids = [p["id"] for p in profiles]
    assert "balanced" in ids
    assert "fast" in ids


@pytest.mark.asyncio
async def test_list_llm_servers(client: AsyncClient) -> None:
    """GET /profiles/llm-servers should return model names keyed by server id."""
    resp = await client.get("/profiles/llm-servers")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, dict)
    # config.yaml defines chat, memory, judge servers
    assert "chat" in data
    assert "memory" in data
    assert "judge" in data
    # Model names should be filename stems (no .gguf extension)
    for model_name in data.values():
        assert not model_name.endswith(".gguf")
