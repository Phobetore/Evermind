"""HTTP client wrapper for llama.cpp compatible LLM servers."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

logger = logging.getLogger(__name__)


class LLMClient:
    """Async HTTP client that speaks the OpenAI-compatible API served by llama.cpp."""

    def __init__(self, base_url: str, timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def health(self) -> bool:
        """Return *True* if the LLM server is reachable."""
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(f"{self.base_url}/health", timeout=5.0)
                return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def chat_completion(
        self, messages: list[dict[str, str]], **params: Any
    ) -> dict[str, Any]:
        """Non-streaming chat completion."""
        payload = {"messages": messages, "stream": False, **params}
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.base_url}/v1/chat/completions",
                json=payload,
                timeout=self.timeout,
            )
            resp.raise_for_status()
            return resp.json()

    async def chat_completion_stream(
        self, messages: list[dict[str, str]], **params: Any
    ) -> AsyncIterator[dict[str, Any]]:
        """Streaming chat completion — yields parsed SSE data chunks."""
        payload = {"messages": messages, "stream": True, **params}
        async with (
            httpx.AsyncClient() as client,
            client.stream(
                "POST",
                f"{self.base_url}/v1/chat/completions",
                json=payload,
                timeout=self.timeout,
            ) as response,
        ):
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[len("data: ") :]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    yield json.loads(data_str)
                except json.JSONDecodeError:
                    logger.warning("Skipping unparseable SSE chunk: %s", data_str)
