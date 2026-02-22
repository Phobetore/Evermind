"""Tests for best-of-N / self-refine pipeline integration in chat_service."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


def _parse_sse_events(text: str) -> list[dict]:
    """Parse SSE data lines from response text."""
    events = []
    for line in text.strip().split("\n"):
        if line.startswith("data: "):
            events.append(json.loads(line[6:]))
    return events


@pytest.mark.asyncio
async def test_chat_meta_reflects_profile_settings(client: AsyncClient) -> None:
    """When the profile has best_of_n > 1, the meta should reflect that."""
    # Create character + conversation
    char_resp = await client.post("/characters", json={"name": "PipelineChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Pipeline test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    # Without a real LLM server the chat will error, but we can verify
    # the service reads profile settings correctly by mocking the LLM
    # health check + run_pipeline.
    mock_result = None  # No judge result for simple fallback

    with (
        patch("app.services.chat_service.LLMClient") as mock_llm_class,
        patch("app.services.chat_service.run_pipeline", new_callable=AsyncMock) as mock_pipeline,
    ):
        # Make the LLM client healthy + mock pipeline return
        instance = mock_llm_class.return_value
        instance.health = AsyncMock(return_value=True)
        mock_pipeline.return_value = ("Mocked pipeline response.", mock_result)

        # Also mock _resolve_llm_client to return our mock
        with patch(
            "app.services.chat_service._resolve_llm_client",
            return_value=instance,
        ):
            resp = await client.post(
                "/chat/stream",
                json={
                    "conversation_id": conv_id,
                    "character_id": char_id,
                    "user_message": "Hello!",
                    "profile_id": "balanced",  # best_of_n=3, self_refine=true
                },
            )
            assert resp.status_code == 200

    events = _parse_sse_events(resp.text)

    # Find the done event
    done_events = [e for e in events if e.get("done")]
    assert len(done_events) == 1
    done = done_events[0]

    # Verify pipeline info is in the meta
    meta = done.get("meta", {})
    pipeline = meta.get("pipeline", {})
    assert pipeline.get("best_of_n") == 3
    assert pipeline.get("self_refine") is True


@pytest.mark.asyncio
async def test_chat_simple_streaming_for_fast_profile(client: AsyncClient) -> None:
    """Profile 'fast' (best_of_n=1, self_refine=false) should use streaming path."""
    char_resp = await client.post("/characters", json={"name": "StreamChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Stream test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    # Mock the LLM to stream tokens
    async def mock_stream(messages, **params):
        yield {"choices": [{"delta": {"content": "Hello "}}]}
        yield {"choices": [{"delta": {"content": "world!"}}]}

    with (
        patch("app.services.chat_service._resolve_llm_client") as mock_resolve,
    ):
        mock_llm = AsyncMock()
        mock_llm.health = AsyncMock(return_value=True)
        mock_llm.chat_completion_stream = mock_stream
        mock_resolve.return_value = mock_llm

        resp = await client.post(
            "/chat/stream",
            json={
                "conversation_id": conv_id,
                "character_id": char_id,
                "user_message": "Hi!",
                "profile_id": "fast",  # best_of_n=1, self_refine=false
            },
        )
        assert resp.status_code == 200

    events = _parse_sse_events(resp.text)

    # Should have token events
    token_events = [e for e in events if "token" in e]
    assert len(token_events) >= 2

    # Should have a done event
    done_events = [e for e in events if e.get("done")]
    assert len(done_events) == 1
    done = done_events[0]

    meta = done.get("meta", {})
    pipeline = meta.get("pipeline", {})
    assert pipeline.get("best_of_n") == 1
    assert pipeline.get("self_refine") is False
