"""HTTP client wrapper for llama.cpp compatible LLM servers."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

logger = logging.getLogger(__name__)

# Number of attempts for non-streaming chat completion calls.
_DEFAULT_RETRIES = 2


class LLMClient:
    """Async HTTP client that speaks the OpenAI-compatible API served by llama.cpp."""

    def __init__(self, base_url: str, timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = httpx.Timeout(
            connect=10.0,
            read=timeout,
            write=10.0,
            pool=10.0,
        )

    async def health(self) -> bool:
        """Return *True* if the LLM server is reachable and ready."""
        return (await self.health_status()) == "ok"

    async def health_status(self) -> str:
        """Return ``'ok'``, ``'loading'``, or ``'unavailable'``.

        llama.cpp returns HTTP 200 when the model is ready and HTTP 503
        with ``{"status": "loading model"}`` while the model is still
        being loaded into memory.
        """
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(f"{self.base_url}/health", timeout=5.0)
                if resp.status_code == 200:
                    return "ok"
                # llama.cpp sends 503 while the model is loading
                try:
                    body = resp.json()
                    if "loading" in str(body.get("status", "")).lower():
                        return "loading"
                except (ValueError, AttributeError):
                    pass
                return "unavailable"
        except (httpx.HTTPError, OSError):
            return "unavailable"

    async def chat_completion(
        self, messages: list[dict[str, str]], **params: Any
    ) -> dict[str, Any]:
        """Non-streaming chat completion with retry on transient read timeouts."""
        payload = {"messages": messages, "stream": False, **params}
        last_exc: httpx.ReadTimeout | None = None
        for attempt in range(1, _DEFAULT_RETRIES + 1):
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.post(
                        f"{self.base_url}/v1/chat/completions",
                        json=payload,
                        timeout=self.timeout,
                    )
                    resp.raise_for_status()
                    return resp.json()
            except httpx.ReadTimeout as exc:
                last_exc = exc
                logger.warning(
                    "LLM read timeout on attempt %d/%d",
                    attempt,
                    _DEFAULT_RETRIES,
                )
                if attempt < _DEFAULT_RETRIES:
                    await asyncio.sleep(2**attempt)
        assert last_exc is not None  # loop always runs; satisfies type checker
        raise last_exc

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
