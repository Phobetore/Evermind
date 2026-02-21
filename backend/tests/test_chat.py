"""Tests for /chat/stream endpoint."""

from __future__ import annotations

import json

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_chat_stream_missing_character(client: AsyncClient) -> None:
    """Streaming with a non-existent character returns an error SSE event."""
    resp = await client.post(
        "/chat/stream",
        json={
            "conversation_id": "fake-conv",
            "character_id": "nonexistent",
            "user_message": "Hello!",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    body = resp.text
    # Should contain an error event
    assert "error" in body
    # Parse the SSE data line
    for line in body.strip().split("\n"):
        if line.startswith("data: "):
            data = json.loads(line[6:])
            assert "error" in data
            break


@pytest.mark.asyncio
async def test_chat_stream_validation(client: AsyncClient) -> None:
    """Empty user message should fail validation."""
    resp = await client.post(
        "/chat/stream",
        json={
            "conversation_id": "c1",
            "character_id": "c1",
            "user_message": "",
        },
    )
    assert resp.status_code == 422
