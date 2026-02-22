"""Tests for rate limiting middleware."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_rate_limiter_allows_normal_traffic(client: AsyncClient) -> None:
    """Requests under the limit should succeed normally."""
    for _ in range(5):
        resp = await client.get("/health")
        assert resp.status_code == 200


@pytest.mark.asyncio
async def test_rate_limiter_returns_429_when_exceeded(client: AsyncClient) -> None:
    """Requests exceeding the limit should return 429."""
    # The default limit is 100 requests per 60s window.
    # Send enough requests to exceed the limit.
    for _ in range(100):
        await client.get("/health")

    # The 101st request should be rate-limited
    resp = await client.get("/health")
    assert resp.status_code == 429
    body = resp.json()
    assert body["detail"] == "Too many requests"
    assert body["status"] == 429
