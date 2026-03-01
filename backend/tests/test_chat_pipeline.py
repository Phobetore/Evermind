"""Tests for best-of-N / self-refine pipeline integration in chat_service."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

import pytest

from app.services.chat_service import ChatService

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

    # Track whether memory extraction was dispatched as a background task
    extraction_dispatched = asyncio.Event()
    original_safe = ChatService._extract_and_store_memories_safe

    async def tracking_wrapper(self, **kwargs):
        extraction_dispatched.set()
        return await original_safe(self, **kwargs)

    async def mock_stream(messages, **params):
        yield {"choices": [{"delta": {"content": "Quick reply."}}]}

    with (
        patch("app.services.chat_service._resolve_llm_client") as mock_resolve,
        patch.object(ChatService, "_extract_and_store_memories_safe", tracking_wrapper),
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
    assert extraction_dispatched.is_set()


@pytest.mark.asyncio
async def test_profile_switch_changes_pipeline_settings(client: AsyncClient) -> None:
    """Switching profile_id between requests must use the corresponding pipeline settings."""
    char_resp = await client.post("/characters", json={"name": "SwitchChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Switch test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    # Helper: send a chat request with the given profile and return pipeline meta
    async def get_pipeline_meta(profile_id: str, extra_gen_params: dict | None = None) -> dict:
        async def mock_stream(messages, **params):
            yield {"choices": [{"delta": {"content": "reply"}}]}

        with patch("app.services.chat_service._resolve_llm_client") as mock_resolve:
            mock_llm = AsyncMock()
            mock_llm.health_status = AsyncMock(return_value="ok")
            mock_llm.chat_completion_stream = mock_stream
            mock_resolve.return_value = mock_llm

            body: dict = {
                "conversation_id": conv_id,
                "character_id": char_id,
                "user_message": f"test with {profile_id}",
                "profile_id": profile_id,
            }
            if extra_gen_params:
                body["generation_params"] = extra_gen_params

            resp = await client.post("/chat/stream", json=body)
            assert resp.status_code == 200

        events = _parse_sse_events(resp.text)
        done = [e for e in events if e.get("done")][0]
        return done["meta"]["pipeline"]

    # Request 1: fast profile → best_of_n=1, no pipeline
    fast_pipeline = await get_pipeline_meta("fast")
    assert fast_pipeline["best_of_n"] == 1
    assert fast_pipeline["self_refine"] is False

    # Request 2: balanced profile → best_of_n=3, pipeline enabled
    with patch("app.services.chat_service.run_pipeline", new_callable=AsyncMock) as mock_pipe:
        mock_pipe.return_value = ("Balanced reply.", None)
        with patch("app.services.chat_service._resolve_llm_client") as mock_resolve:
            mock_llm = AsyncMock()
            mock_llm.health_status = AsyncMock(return_value="ok")
            mock_resolve.return_value = mock_llm

            resp = await client.post(
                "/chat/stream",
                json={
                    "conversation_id": conv_id,
                    "character_id": char_id,
                    "user_message": "test balanced",
                    "profile_id": "balanced",
                },
            )
            assert resp.status_code == 200

    events = _parse_sse_events(resp.text)
    done = [e for e in events if e.get("done")][0]
    balanced_pipeline = done["meta"]["pipeline"]
    assert balanced_pipeline["best_of_n"] == 3
    assert balanced_pipeline["self_refine"] is True


@pytest.mark.asyncio
async def test_gen_params_best_of_n_does_not_leak_to_llm(client: AsyncClient) -> None:
    """If generation_params contains best_of_n/self_refine, they should be stripped
    before forwarding to the LLM so they cannot override profile settings silently."""
    char_resp = await client.post("/characters", json={"name": "LeakChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Leak test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    captured_params: dict = {}

    async def capturing_stream(messages, **params):
        captured_params.update(params)
        yield {"choices": [{"delta": {"content": "ok"}}]}

    with patch("app.services.chat_service._resolve_llm_client") as mock_resolve:
        mock_llm = AsyncMock()
        mock_llm.health_status = AsyncMock(return_value="ok")
        mock_llm.chat_completion_stream = capturing_stream
        mock_resolve.return_value = mock_llm

        # Send best_of_n=1 and self_refine=false (matching the fast profile)
        # so the service still uses the simple streaming path, but these keys
        # should still be popped from gen_params before the LLM call.
        resp = await client.post(
            "/chat/stream",
            json={
                "conversation_id": conv_id,
                "character_id": char_id,
                "user_message": "leak test",
                "profile_id": "fast",
                "generation_params": {
                    "temperature": 0.5,
                    "best_of_n": 1,
                    "self_refine": False,
                },
            },
        )
        assert resp.status_code == 200

    # best_of_n and self_refine should NOT reach the LLM call
    assert "best_of_n" not in captured_params
    assert "self_refine" not in captured_params
    assert captured_params.get("temperature") == 0.5
