"""Tests for best-of-N / self-refine pipeline integration in chat_service."""

from __future__ import annotations

import asyncio
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
    mock_judge_result = None  # No judge result for simple fallback

    with (
        patch("app.services.chat_service.LLMClient") as mock_llm_class,
        patch("app.services.chat_service.run_pipeline", new_callable=AsyncMock) as mock_pipeline,
    ):
        # Make the LLM client healthy + mock pipeline return
        instance = mock_llm_class.return_value
        instance.health_status = AsyncMock(return_value="ok")
        mock_pipeline.return_value = ("Mocked pipeline response.", mock_judge_result)

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
        mock_llm.health_status = AsyncMock(return_value="ok")
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


@pytest.mark.asyncio
async def test_pipeline_emits_status_events(client: AsyncClient) -> None:
    """Pipeline path should emit status events including the initial generating event."""
    char_resp = await client.post("/characters", json={"name": "StatusChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Status test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    with (
        patch("app.services.chat_service.LLMClient") as mock_llm_class,
        patch("app.services.chat_service.run_pipeline", new_callable=AsyncMock) as mock_pipeline,
    ):
        instance = mock_llm_class.return_value
        instance.health_status = AsyncMock(return_value="ok")
        mock_pipeline.return_value = ("Pipeline response.", None)

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
                    "profile_id": "balanced",
                },
            )
            assert resp.status_code == 200

    events = _parse_sse_events(resp.text)

    # Should contain at least one status event (the initial "Generating N candidate(s)" event)
    status_events = [e for e in events if "status" in e]
    assert len(status_events) >= 1
    assert status_events[0]["status"] == "generating"
    assert "candidate" in status_events[0]["detail"].lower()

    # Should also have token events and a done event
    token_events = [e for e in events if "token" in e]
    assert len(token_events) >= 1
    done_events = [e for e in events if e.get("done")]
    assert len(done_events) == 1


@pytest.mark.asyncio
async def test_pipeline_heartbeat_during_slow_pipeline(client: AsyncClient) -> None:
    """Pipeline should emit heartbeat events when generation takes longer than the heartbeat interval."""
    char_resp = await client.post("/characters", json={"name": "HeartbeatChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Heartbeat test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    async def _slow_pipeline(*_args, **_kwargs):
        """Simulate a pipeline that takes a bit longer than the heartbeat interval."""
        await asyncio.sleep(0.15)
        return ("Slow pipeline response.", None)

    with (
        patch("app.services.chat_service.LLMClient") as mock_llm_class,
        patch("app.services.chat_service.run_pipeline", side_effect=_slow_pipeline),
        # Use a very short heartbeat interval for fast test
        patch("app.services.chat_service._HEARTBEAT_INTERVAL", 0.05),
    ):
        instance = mock_llm_class.return_value
        instance.health_status = AsyncMock(return_value="ok")

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
                    "profile_id": "balanced",
                },
            )
            assert resp.status_code == 200

    events = _parse_sse_events(resp.text)

    # Should contain at least 2 status events (initial + heartbeat(s))
    status_events = [e for e in events if "status" in e]
    assert len(status_events) >= 2

    # The heartbeat events should have "Still generating..." detail
    heartbeats = [e for e in status_events if "still" in e.get("detail", "").lower()]
    assert len(heartbeats) >= 1

    # Should still have a done event
    done_events = [e for e in events if e.get("done")]
    assert len(done_events) == 1


@pytest.mark.asyncio
async def test_memory_extraction_does_not_block_done_event(client: AsyncClient) -> None:
    """Memory extraction should run as a background task, not block the done event."""
    char_resp = await client.post("/characters", json={"name": "MemNonBlockChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "MemNonBlock test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    # Track whether memory extraction was dispatched
    extraction_started = asyncio.Event()

    original_create_task = asyncio.create_task

    def patched_create_task(coro):
        extraction_started.set()
        return original_create_task(coro)

    async def mock_stream(messages, **params):
        yield {"choices": [{"delta": {"content": "Quick reply."}}]}

    with (
        patch("app.services.chat_service._resolve_llm_client") as mock_resolve,
        patch("app.services.chat_service.asyncio.create_task", side_effect=patched_create_task),
    ):
        mock_llm = AsyncMock()
        mock_llm.health_status = AsyncMock(return_value="ok")
        mock_llm.chat_completion_stream = mock_stream
        mock_resolve.return_value = mock_llm

        resp = await client.post(
            "/chat/stream",
            json={
                "conversation_id": conv_id,
                "character_id": char_id,
                "user_message": "Quick test!",
                "profile_id": "fast",
            },
        )
        assert resp.status_code == 200

    events = _parse_sse_events(resp.text)

    # The done event should be present (not blocked by memory extraction)
    done_events = [e for e in events if e.get("done")]
    assert len(done_events) == 1

    # Memory extraction should have been dispatched as a background task
    assert extraction_started.is_set()
