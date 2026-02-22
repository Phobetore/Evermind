"""Tests for the LLM client timeout and retry behaviour."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.core.llm_client import _DEFAULT_RETRIES, LLMClient


def test_timeout_uses_httpx_timeout_object() -> None:
    """LLMClient should construct an httpx.Timeout with a long read timeout."""
    client = LLMClient(base_url="http://localhost:8081", timeout=180.0)
    assert isinstance(client.timeout, httpx.Timeout)
    assert client.timeout.read == 180.0
    assert client.timeout.connect == 10.0


def test_default_timeout_values() -> None:
    """Default 120s should map to 120s read timeout."""
    client = LLMClient(base_url="http://localhost:8081")
    assert client.timeout.read == 120.0
    assert client.timeout.connect == 10.0
    assert client.timeout.write == 10.0
    assert client.timeout.pool == 10.0


@pytest.mark.asyncio
async def test_chat_completion_retries_on_read_timeout() -> None:
    """chat_completion should retry on ReadTimeout before re-raising."""
    client = LLMClient(base_url="http://localhost:8081")

    with (
        patch("app.core.llm_client.asyncio.sleep", new_callable=AsyncMock) as mock_sleep,
        patch("httpx.AsyncClient.post", side_effect=httpx.ReadTimeout("timed out")),
        pytest.raises(httpx.ReadTimeout),
    ):
        await client.chat_completion([{"role": "user", "content": "hi"}])

    # Should have retried (_DEFAULT_RETRIES - 1) times with backoff sleep
    assert mock_sleep.call_count == _DEFAULT_RETRIES - 1


@pytest.mark.asyncio
async def test_chat_completion_succeeds_on_retry() -> None:
    """chat_completion should succeed if the second attempt works."""
    client = LLMClient(base_url="http://localhost:8081")

    mock_response = httpx.Response(
        200,
        json={"choices": [{"message": {"content": "hello"}}]},
        request=httpx.Request("POST", "http://localhost:8081/v1/chat/completions"),
    )

    call_count = 0

    async def mock_post(*args, **kwargs):  # noqa: ANN002, ANN003
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise httpx.ReadTimeout("timed out")
        return mock_response

    with (
        patch("app.core.llm_client.asyncio.sleep", new_callable=AsyncMock),
        patch("httpx.AsyncClient.post", side_effect=mock_post),
    ):
        result = await client.chat_completion([{"role": "user", "content": "hi"}])

    assert call_count == 2
    assert result["choices"][0]["message"]["content"] == "hello"


@pytest.mark.asyncio
async def test_chat_completion_no_retry_on_other_errors() -> None:
    """Non-ReadTimeout exceptions should propagate immediately without retry."""
    client = LLMClient(base_url="http://localhost:8081")

    with (
        patch("httpx.AsyncClient.post", side_effect=httpx.ConnectError("refused")),
        pytest.raises(httpx.ConnectError),
    ):
        await client.chat_completion([{"role": "user", "content": "hi"}])
