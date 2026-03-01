"""Tests for the character assistant tool."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.tools.character_assistant import (
    build_assistant_prompt,
    generate_character,
    parse_assistant_response,
)

if TYPE_CHECKING:
    from httpx import AsyncClient


def test_build_assistant_prompt_structure() -> None:
    """Prompt should be a single system message with the character name embedded."""
    messages = build_assistant_prompt(name="Luna", theme="fantasy", style="poetic")
    assert len(messages) == 1
    assert messages[0]["role"] == "system"
    assert "Luna" in messages[0]["content"]
    assert "fantasy" in messages[0]["content"]
    assert "poetic" in messages[0]["content"]


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
async def test_character_assistant_read_error_returns_503(client: AsyncClient) -> None:
    """POST /tools/character_assistant should return 503 on httpx.ReadError."""
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
    assert resp.status_code == 503
    assert "unreachable" in resp.json()["detail"]


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
async def test_character_assistant_http_status_error_returns_503(client: AsyncClient) -> None:
    """POST /tools/character_assistant should return 503 on httpx.HTTPStatusError."""
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
    assert resp.status_code == 503
    assert "unreachable" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_character_assistant_timeout_returns_504(client: AsyncClient) -> None:
    """POST /tools/character_assistant should return 504 when LLM generation stalls."""
    mock_llm = AsyncMock()
    mock_llm.health_status = AsyncMock(return_value="ok")

    async def _slow_stream(*_args: object, **_kwargs: object):  # type: ignore[misc]
        await asyncio.sleep(999)
        yield {}  # pragma: no cover — never reached

    mock_llm.chat_completion_stream = _slow_stream

    with (
        patch("app.routers.tools._resolve_llm_client", return_value=mock_llm),
        patch("app.tools.character_assistant._INACTIVITY_TIMEOUT", 0.05),
    ):
        resp = await client.post(
            "/tools/character_assistant",
            json={"name": "TestChar", "theme": "sci-fi"},
        )
    assert resp.status_code == 504
    assert "timed out" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_character_assistant_unexpected_error_returns_500(client: AsyncClient) -> None:
    """POST /tools/character_assistant should return 500 on unexpected exceptions."""
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
    assert resp.status_code == 500
    assert "unexpectedly" in resp.json()["detail"]


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
