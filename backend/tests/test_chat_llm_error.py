"""Tests for graceful LLM connection error handling in chat."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

import httpx
import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_chat_stream_llm_unreachable(client: AsyncClient) -> None:
    """When the LLM server is not running, the SSE error should be descriptive."""
    # Create a character
    char_resp = await client.post("/characters", json={"name": "TestChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    # Create a conversation
    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Test conv"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    # Try to chat — no LLM server is running, so we should get a clear error
    resp = await client.post(
        "/chat/stream",
        json={
            "conversation_id": conv_id,
            "character_id": char_id,
            "user_message": "Hello!",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    # Parse SSE data lines for an error event
    found_error = False
    for line in resp.text.strip().split("\n"):
        if line.startswith("data: "):
            data = json.loads(line[6:])
            if "error" in data:
                found_error = True
                error_msg = data["error"]
                # The error should mention the server is unreachable or not configured,
                # not just a generic "LLM streaming failed"
                assert "not configured" in error_msg or "not reachable" in error_msg
                assert "LLM streaming failed" not in error_msg
                break

    assert found_error, "Expected an error SSE event about LLM server unreachability"


@pytest.mark.asyncio
async def test_chat_stream_llm_read_error(client: AsyncClient) -> None:
    """An httpx.ReadError during streaming should produce a descriptive SSE error, not a 500."""
    char_resp = await client.post("/characters", json={"name": "ReadErrChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "ReadErr conv"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    async def _raise_read_error(messages, **params):
        # The yield is unreachable but necessary to make Python treat
        # this function as an async generator (matching the return type
        # of chat_completion_stream).
        raise httpx.ReadError("peer closed connection")
        yield  # pragma: no cover

    with patch("app.services.chat_service._resolve_llm_client") as mock_resolve:
        mock_llm = AsyncMock()
        mock_llm.health = AsyncMock(return_value=True)
        mock_llm.chat_completion_stream = _raise_read_error
        mock_resolve.return_value = mock_llm

        resp = await client.post(
            "/chat/stream",
            json={
                "conversation_id": conv_id,
                "character_id": char_id,
                "user_message": "Hello!",
                "profile_id": "fast",
            },
        )
        assert resp.status_code == 200

    found_error = False
    for line in resp.text.strip().split("\n"):
        if line.startswith("data: "):
            data = json.loads(line[6:])
            if "error" in data:
                found_error = True
                error_msg = data["error"]
                assert "Cannot connect" in error_msg
                assert "LLM streaming failed" not in error_msg
                break

    assert found_error, "Expected a descriptive SSE error for ReadError"
