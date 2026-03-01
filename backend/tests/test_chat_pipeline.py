"""Tests for best-of-N / self-refine pipeline integration in chat_service."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any
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
    async def get_pipeline_meta(profile_id: str, generation_params: dict | None = None) -> dict:
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
            if generation_params:
                body["generation_params"] = generation_params

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

    captured_params: dict[str, Any] = {}

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


@pytest.mark.asyncio
async def test_profile_generation_defaults_injected_into_stream(client: AsyncClient) -> None:
    """Profile generation_defaults (frequency_penalty, presence_penalty) must be
    forwarded to the LLM streaming call even when the user doesn't supply them."""
    char_resp = await client.post("/characters", json={"name": "PenaltyChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Penalty test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    captured_params: dict[str, Any] = {}

    async def capturing_stream(messages, **params):
        captured_params.update(params)
        yield {"choices": [{"delta": {"content": "ok"}}]}

    with patch("app.services.chat_service._resolve_llm_client") as mock_resolve:
        mock_llm = AsyncMock()
        mock_llm.health_status = AsyncMock(return_value="ok")
        mock_llm.chat_completion_stream = capturing_stream
        mock_resolve.return_value = mock_llm

        resp = await client.post(
            "/chat/stream",
            json={
                "conversation_id": conv_id,
                "character_id": char_id,
                "user_message": "penalty test",
                "profile_id": "fast",  # No custom generation_params
            },
        )
        assert resp.status_code == 200

    # Default penalties from ProfileConfig should be present
    assert "frequency_penalty" in captured_params
    assert captured_params["frequency_penalty"] > 0
    assert "presence_penalty" in captured_params
    assert captured_params["presence_penalty"] > 0


@pytest.mark.asyncio
async def test_gen_params_quality_mode_does_not_leak_to_llm(client: AsyncClient) -> None:
    """quality_mode should be consumed by the backend and not forwarded to the LLM runtime."""
    char_resp = await client.post("/characters", json={"name": "ModeLeakChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Mode leak test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    captured_params: dict[str, Any] = {}

    async def capturing_stream(messages, **params):
        captured_params.update(params)
        yield {"choices": [{"delta": {"content": "ok"}}]}

    with patch("app.services.chat_service._resolve_llm_client") as mock_resolve:
        mock_llm = AsyncMock()
        mock_llm.health_status = AsyncMock(return_value="ok")
        mock_llm.chat_completion_stream = capturing_stream
        mock_resolve.return_value = mock_llm

        resp = await client.post(
            "/chat/stream",
            json={
                "conversation_id": conv_id,
                "character_id": char_id,
                "user_message": "mode leak",
                "profile_id": "fast",
                "generation_params": {
                    "quality_mode": "fast",
                    "temperature": 0.51,
                },
            },
        )
        assert resp.status_code == 200

    assert "quality_mode" not in captured_params
    assert captured_params.get("temperature") == 0.51


@pytest.mark.asyncio
async def test_quality_mode_meta_is_reported(client: AsyncClient) -> None:
    """The done-event meta should report the selected quality_mode."""
    char_resp = await client.post("/characters", json={"name": "ModeMetaChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Mode meta test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    with (
        patch("app.services.chat_service._resolve_llm_client") as mock_resolve,
        patch("app.services.chat_service.run_pipeline", new_callable=AsyncMock) as mock_pipeline,
    ):
        mock_llm = AsyncMock()
        mock_llm.health_status = AsyncMock(return_value="ok")
        mock_resolve.return_value = mock_llm
        mock_pipeline.return_value = ("meta ok", None)

        resp = await client.post(
            "/chat/stream",
            json={
                "conversation_id": conv_id,
                "character_id": char_id,
                "user_message": "meta mode",
                "profile_id": "fast",
                "generation_params": {
                    "quality_mode": "immersive",
                },
            },
        )
        assert resp.status_code == 200

    events = _parse_sse_events(resp.text)
    done = [e for e in events if e.get("done")][0]
    assert done["meta"]["pipeline"]["quality_mode"] == "immersive"


@pytest.mark.asyncio
async def test_memory_extraction_non_dict_response_is_ignored(client: AsyncClient) -> None:
    """Non-dict responses from memory extraction should be ignored without failing the turn."""
    char_resp = await client.post("/characters", json={"name": "MemGuardChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Mem guard test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    async def mock_stream(messages, **params):
        yield {"choices": [{"delta": {"content": "guarded reply"}}]}

    with patch("app.services.chat_service._resolve_llm_client") as mock_resolve:
        mock_llm = AsyncMock()
        mock_llm.health_status = AsyncMock(return_value="ok")
        mock_llm.chat_completion_stream = mock_stream
        mock_llm.chat_completion = AsyncMock(return_value=["invalid-response-shape"])
        mock_resolve.return_value = mock_llm

        resp = await client.post(
            "/chat/stream",
            json={
                "conversation_id": conv_id,
                "character_id": char_id,
                "user_message": "memory guard",
                "profile_id": "fast",
            },
        )
        assert resp.status_code == 200

    events = _parse_sse_events(resp.text)
    done = [e for e in events if e.get("done")][0]
    assert done["meta"]["pipeline"]["memory_extract_enabled"] is True


@pytest.mark.asyncio
async def test_done_meta_includes_quality_signals(client: AsyncClient) -> None:
    """Done-event meta should include lightweight quality telemetry fields."""
    char_resp = await client.post("/characters", json={"name": "QualitySignalsChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Quality signals test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    async def mock_stream(messages, **params):
        yield {"choices": [{"delta": {"content": "hello hello world"}}]}

    with patch("app.services.chat_service._resolve_llm_client") as mock_resolve:
        mock_llm = AsyncMock()
        mock_llm.health_status = AsyncMock(return_value="ok")
        mock_llm.chat_completion_stream = mock_stream
        mock_resolve.return_value = mock_llm

        resp = await client.post(
            "/chat/stream",
            json={
                "conversation_id": conv_id,
                "character_id": char_id,
                "user_message": "quality?",
                "profile_id": "fast",
            },
        )
        assert resp.status_code == 200

    events = _parse_sse_events(resp.text)
    done = [e for e in events if e.get("done")][0]
    signals = done["meta"].get("quality_signals", {})

    assert "response_words" in signals
    assert "repetition_ratio" in signals
    assert "lexical_diversity" in signals
    assert signals["response_words"] >= 1
    assert 0.0 <= signals["repetition_ratio"] <= 1.0
    assert 0.0 <= signals["lexical_diversity"] <= 1.0


@pytest.mark.asyncio
async def test_done_meta_includes_retrieval_summary(client: AsyncClient) -> None:
    """Done-event meta should include retrieval explainability summary."""
    char_resp = await client.post("/characters", json={"name": "RetrievalMetaChar"})
    assert char_resp.status_code == 201
    char_id = char_resp.json()["id"]

    conv_resp = await client.post(
        "/conversations",
        json={"character_id": char_id, "title": "Retrieval meta test"},
    )
    assert conv_resp.status_code == 201
    conv_id = conv_resp.json()["id"]

    async def mock_stream(messages, **params):
        yield {"choices": [{"delta": {"content": "retrieval meta"}}]}

    with patch("app.services.chat_service._resolve_llm_client") as mock_resolve:
        mock_llm = AsyncMock()
        mock_llm.health_status = AsyncMock(return_value="ok")
        mock_llm.chat_completion_stream = mock_stream
        mock_resolve.return_value = mock_llm

        resp = await client.post(
            "/chat/stream",
            json={
                "conversation_id": conv_id,
                "character_id": char_id,
                "user_message": "retrieval?",
                "profile_id": "fast",
            },
        )
        assert resp.status_code == 200

    events = _parse_sse_events(resp.text)
    done = [e for e in events if e.get("done")][0]
    retrieval = done["meta"].get("retrieval", {})

    assert "selected_n" in retrieval
    assert "memory_ids_selected" in retrieval
    assert "memory_summaries" in retrieval
    assert "scoring" in retrieval
    assert isinstance(retrieval["memory_ids_selected"], list)
    assert isinstance(retrieval["memory_summaries"], list)
    assert isinstance(retrieval["scoring"], dict)
    assert retrieval["scoring"].get("formula") == "score = importance * confidence"
    assert retrieval["scoring"].get("strategy") == "static"
    assert retrieval["scoring"].get("weight_importance") == 1.0
    assert retrieval["scoring"].get("weight_confidence") == 1.0
    if retrieval["memory_summaries"]:
        first = retrieval["memory_summaries"][0]
        assert "rank" in first
        assert "score" in first
        assert isinstance(first.get("importance"), float)
        assert isinstance(first.get("confidence"), float)
