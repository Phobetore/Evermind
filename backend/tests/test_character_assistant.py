"""Tests for the character assistant tool."""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.tools.character_assistant import (
    build_assistant_prompt,
    generate_character,
    generate_character_stream,
    parse_assistant_response,
)

if TYPE_CHECKING:
    from httpx import AsyncClient


def _parse_sse_events(text: str) -> list[dict]:
    """Parse SSE text into a list of JSON event dicts."""
    events = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data: "):
            with contextlib.suppress(json.JSONDecodeError):
                events.append(json.loads(line[6:]))
    return events


def test_build_assistant_prompt_structure() -> None:
    """Prompt should be a system message + user message with the character name embedded."""
    messages = build_assistant_prompt(name="Luna", theme="fantasy", style="poetic")
    assert len(messages) == 2
    assert messages[0]["role"] == "system"
    assert "Luna" in messages[0]["content"]
    assert "fantasy" in messages[0]["content"]
    assert "poetic" in messages[0]["content"]
    assert messages[1]["role"] == "user"


def test_parse_assistant_response_valid_json() -> None:
    """Valid JSON should be parsed correctly."""
    raw = """{
        "name": "Luna",
        "tags": ["elf", "healer"],
        "summary": "An elven healer.",
        "persona": "Kind and wise.",
        "writing_style": "Flowing prose.",
        "scenario": "In a forest.",
        "first_message": "Hello traveler.",
        "example_dialogues": [{"user": "Hi", "assistant": "Greetings!"}],
        "boundaries": "No violence.",
        "system_rules": "Stay in character.",
        "memory_seed": [{"type": "semantic", "title": "Healer", "content": "Luna is a healer."}]
    }"""
    result = parse_assistant_response(raw)
    assert result["name"] == "Luna"
    assert "elf" in result["tags"]
    assert len(result["example_dialogues"]) == 1
    assert len(result["memory_seed"]) == 1


def test_parse_assistant_response_with_fences() -> None:
    """JSON wrapped in markdown fences should still parse."""
    raw = """```json
{
    "name": "Luna",
    "tags": [],
    "summary": "A character.",
    "persona": "Nice.",
    "writing_style": "",
    "scenario": "",
    "first_message": "",
    "example_dialogues": [],
    "boundaries": "",
    "system_rules": "",
    "memory_seed": []
}
```"""
    result = parse_assistant_response(raw)
    assert result["name"] == "Luna"


def test_parse_assistant_response_invalid_json() -> None:
    """Invalid JSON should return fallback dict."""
    result = parse_assistant_response("not json at all")
    assert result["name"] == ""
    assert result["tags"] == []


def test_parse_assistant_response_non_dict() -> None:
    """Non-dict JSON should return fallback dict."""
    result = parse_assistant_response("[1, 2, 3]")
    assert result["name"] == ""


def test_parse_assistant_response_missing_fields() -> None:
    """Missing fields should get defaults."""
    result = parse_assistant_response('{"name": "Test"}')
    assert result["name"] == "Test"
    assert result["tags"] == []
    assert result["summary"] == ""
    assert result["persona"] == ""


@pytest.mark.asyncio
async def test_generate_character_accumulates_streamed_tokens() -> None:
    """generate_character should collect streamed tokens and parse the final JSON."""
    json_str = '{"name":"Luna","tags":["elf"],"summary":"An elf.","persona":"Kind."}'

    async def _fake_stream(*_a: object, **_kw: object):  # type: ignore[misc]
        for ch in json_str:
            yield {"choices": [{"delta": {"content": ch}}]}

    mock_llm = AsyncMock()
    mock_llm.chat_completion_stream = _fake_stream

    result = await generate_character(mock_llm, name="Luna")
    assert result["name"] == "Luna"
    assert "elf" in result["tags"]
    assert result["summary"] == "An elf."


@pytest.mark.asyncio
async def test_character_assistant_endpoint_no_server(client: AsyncClient) -> None:
    """POST /tools/character_assistant should return 503 when LLM is not configured."""
    resp = await client.post(
        "/tools/character_assistant",
        json={"name": "TestChar", "theme": "sci-fi"},
    )
    # LLM server is not running in tests, so expect 503
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_character_assistant_endpoint_validation(client: AsyncClient) -> None:
    """POST /tools/character_assistant with empty name should return 422."""
    resp = await client.post(
        "/tools/character_assistant",
        json={"name": ""},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_character_assistant_read_error_returns_error_event(client: AsyncClient) -> None:
    """POST /tools/character_assistant should send an SSE error event on httpx.ReadError."""
    mock_llm = AsyncMock()
    mock_llm.health_status = AsyncMock(return_value="ok")

    async def _error_stream(*_a: object, **_kw: object):  # type: ignore[misc]
        raise httpx.ReadError("peer closed")
        yield  # pragma: no cover — makes this an async generator

    mock_llm.chat_completion_stream = _error_stream

    with patch("app.routers.tools._resolve_llm_client", return_value=mock_llm):
        resp = await client.post(
            "/tools/character_assistant",
            json={"name": "TestChar", "theme": "sci-fi"},
        )
    assert resp.status_code == 200
    events = _parse_sse_events(resp.text)
    assert any("error" in e for e in events)
    assert any("unreachable" in e.get("error", "") for e in events)


@pytest.mark.asyncio
async def test_character_assistant_loading_returns_503(client: AsyncClient) -> None:
    """POST /tools/character_assistant should return 503 when the LLM is still loading."""
    mock_llm = AsyncMock()
    mock_llm.health_status = AsyncMock(return_value="loading")

    with patch("app.routers.tools._resolve_llm_client", return_value=mock_llm):
        resp = await client.post(
            "/tools/character_assistant",
            json={"name": "TestChar", "theme": "sci-fi"},
        )
    assert resp.status_code == 503
    assert "loading" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_character_assistant_http_status_error_returns_error_event(client: AsyncClient) -> None:
    """POST /tools/character_assistant should send an SSE error event on httpx.HTTPStatusError."""
    mock_llm = AsyncMock()
    mock_llm.health_status = AsyncMock(return_value="ok")
    mock_resp = httpx.Response(503, request=httpx.Request("POST", "http://test"))

    async def _status_error_stream(*_a: object, **_kw: object):  # type: ignore[misc]
        raise httpx.HTTPStatusError(
            "Server Error", request=mock_resp.request, response=mock_resp
        )
        yield  # pragma: no cover — makes this an async generator

    mock_llm.chat_completion_stream = _status_error_stream

    with patch("app.routers.tools._resolve_llm_client", return_value=mock_llm):
        resp = await client.post(
            "/tools/character_assistant",
            json={"name": "TestChar", "theme": "sci-fi"},
        )
    assert resp.status_code == 200
    events = _parse_sse_events(resp.text)
    assert any("unreachable" in e.get("error", "") for e in events)


@pytest.mark.asyncio
async def test_character_assistant_endpoint_streams_sse(client: AsyncClient) -> None:
    """POST /tools/character_assistant should stream SSE token events then a done event."""
    json_str = '{"name":"Luna","tags":["elf"],"summary":"An elf.","persona":"Kind."}'

    async def _fake_stream(*_a: object, **_kw: object):  # type: ignore[misc]
        for ch in json_str:
            yield {"choices": [{"delta": {"content": ch}}]}

    mock_llm = AsyncMock()
    mock_llm.health_status = AsyncMock(return_value="ok")
    mock_llm.chat_completion_stream = _fake_stream

    with patch("app.routers.tools._resolve_llm_client", return_value=mock_llm):
        resp = await client.post(
            "/tools/character_assistant",
            json={"name": "Luna", "theme": "fantasy"},
        )
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers.get("content-type", "")

    events = _parse_sse_events(resp.text)
    # Should have token events followed by a done event
    token_events = [e for e in events if "token" in e]
    done_events = [e for e in events if e.get("done") is True]
    assert len(token_events) > 0
    assert len(done_events) == 1
    result = done_events[0]["result"]
    assert result["name"] == "Luna"
    assert "elf" in result["tags"]


@pytest.mark.asyncio
async def test_character_assistant_unexpected_error_returns_error_event(client: AsyncClient) -> None:
    """POST /tools/character_assistant should send an SSE error event on unexpected exceptions."""
    mock_llm = AsyncMock()
    mock_llm.health_status = AsyncMock(return_value="ok")

    async def _unexpected_stream(*_a: object, **_kw: object):  # type: ignore[misc]
        raise RuntimeError("something unexpected")
        yield  # pragma: no cover — makes this an async generator

    mock_llm.chat_completion_stream = _unexpected_stream

    with patch("app.routers.tools._resolve_llm_client", return_value=mock_llm):
        resp = await client.post(
            "/tools/character_assistant",
            json={"name": "TestChar", "theme": "sci-fi"},
        )
    assert resp.status_code == 200
    events = _parse_sse_events(resp.text)
    assert any("unexpectedly" in e.get("error", "") for e in events)


@pytest.mark.asyncio
async def test_generate_character_inactivity_timeout() -> None:
    """generate_character should raise TimeoutError when the stream stalls."""

    async def _stalling_stream(*_a: object, **_kw: object):  # type: ignore[misc]
        yield {"choices": [{"delta": {"content": "{"}}]}
        # Stall indefinitely after first token
        await asyncio.sleep(999)
        yield {}  # pragma: no cover

    mock_llm = AsyncMock()
    mock_llm.chat_completion_stream = _stalling_stream

    with pytest.raises(TimeoutError):
        await generate_character(mock_llm, name="Luna", inactivity_timeout=0.05)


@pytest.mark.asyncio
async def test_generate_character_slow_but_active_succeeds() -> None:
    """Slow-but-active generation should succeed — no wall-clock cap."""
    json_str = '{"name":"Luna","tags":["elf"],"summary":"An elf.","persona":"Kind."}'

    async def _slow_but_active_stream(*_a: object, **_kw: object):  # type: ignore[misc]
        for ch in json_str:
            await asyncio.sleep(0.01)  # slow but steady token production
            yield {"choices": [{"delta": {"content": ch}}]}

    mock_llm = AsyncMock()
    mock_llm.chat_completion_stream = _slow_but_active_stream

    # Total time: ~len(json_str)*0.01s ≈ 0.7s, well above the
    # inactivity_timeout if it were used as a wall-clock cap.
    result = await generate_character(
        mock_llm, name="Luna", inactivity_timeout=0.2,
    )
    assert result["name"] == "Luna"
    assert "elf" in result["tags"]


@pytest.mark.asyncio
async def test_generate_character_stream_yields_tokens() -> None:
    """generate_character_stream should yield each token individually."""
    json_str = '{"name":"Luna","tags":["elf"],"summary":"An elf.","persona":"Kind."}'

    async def _fake_stream(*_a: object, **_kw: object):  # type: ignore[misc]
        for ch in json_str:
            yield {"choices": [{"delta": {"content": ch}}]}

    mock_llm = AsyncMock()
    mock_llm.chat_completion_stream = _fake_stream

    tokens: list[str] = []
    async for token in generate_character_stream(mock_llm, name="Luna"):
        tokens.append(token)

    assert "".join(tokens) == json_str
