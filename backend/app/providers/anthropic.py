"""Anthropic Messages API provider.

Differences handled here: system prompt is a top-level field, messages must
strictly alternate starting with `user` (we merge consecutive same-role turns
and insert a synthetic opener), penalties are unsupported, and
`post_history_instructions` is suffixed to the last user message.
"""

import json
from collections.abc import AsyncIterator

import httpx

from ..errors import MODEL_ERROR
from ..prompting.engine import PromptPayload
from .base import (
    NETWORK_ERROR,
    TIMEOUT,
    UNEXPECTED_RESPONSE,
    Provider,
    ProviderError,
    ProviderEvent,
    excerpt,
    failure,
    status_failure,
)

API_VERSION = "2023-06-01"


class AnthropicProvider(Provider):
    def _headers(self) -> dict:
        return {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": API_VERSION,
        }

    def _build_messages(self, payload: PromptPayload) -> list[dict]:
        merged: list[dict] = []
        for message in payload.messages:
            content = message.get("content") or ""
            if not content:
                continue
            if merged and merged[-1]["role"] == message["role"]:
                merged[-1]["content"] += "\n\n" + content
            else:
                merged.append({"role": message["role"], "content": content})
        if not merged or merged[0]["role"] != "user":
            merged.insert(0, {"role": "user", "content": "[Begin the roleplay.]"})
        if payload.post_history:
            for message in reversed(merged):
                if message["role"] == "user":
                    message["content"] += f"\n\n[{payload.post_history}]"
                    break
        return merged

    def _build_body(self, payload: PromptPayload) -> dict:
        conn = self.connection
        body = {
            "model": self.model,
            "system": payload.system,
            "messages": self._build_messages(payload),
            "stream": True,
            "max_tokens": int(conn.get("max_tokens") or 1024),
            "temperature": min(1.0, float(conn.get("temperature") or 0.9)),
            "top_p": float(conn.get("top_p") or 0.95),
        }
        if payload.stop:
            body["stop_sequences"] = [s for s in payload.stop if s.strip()][:4]
        extra = conn.get("extra_params") or {}
        if isinstance(extra, dict):
            body.update(extra)
        return body

    async def stream_chat(self, payload: PromptPayload) -> AsyncIterator[ProviderEvent]:
        usage = None
        stop_reason = None
        try:
            async with self._client_factory() as client, client.stream(
                "POST",
                f"{self.base_url}/v1/messages",
                headers=self._headers(),
                json=self._build_body(payload),
            ) as response:
                if response.status_code >= 400:
                    detail = await _read_error(response)
                    yield ProviderEvent(
                        type="error",
                        message=f"Anthropic error ({response.status_code}). {detail}".strip(),
                        meta=status_failure(response.status_code, detail),
                    )
                    return
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    try:
                        obj = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        continue
                    kind = obj.get("type")
                    if kind == "content_block_delta":
                        text = (obj.get("delta") or {}).get("text")
                        if text:
                            yield ProviderEvent(type="delta", text=text)
                    elif kind == "message_delta":
                        usage = obj.get("usage") or usage
                        stop_reason = (obj.get("delta") or {}).get("stop_reason") or stop_reason
                    elif kind == "error":
                        message = (obj.get("error") or {}).get("message") or "Anthropic stream error."
                        yield ProviderEvent(type="error", message=message,
                                            meta=failure(MODEL_ERROR))
                        return
                    elif kind == "message_stop":
                        break
        except httpx.ConnectError:
            yield ProviderEvent(type="error", message=self._connect_error_message(),
                                meta=self._unreachable())
            return
        except httpx.TimeoutException:
            yield ProviderEvent(type="error", message="Anthropic took too long to respond (timeout).",
                                meta=failure(TIMEOUT))
            return
        except httpx.HTTPError as exc:
            yield ProviderEvent(type="error", message=f"Network error: {exc}",
                                meta=failure(NETWORK_ERROR, upstream=str(exc)))
            return
        yield ProviderEvent(type="done", usage=usage, meta={"finish_reason": stop_reason})

    async def list_models(self) -> list[str]:
        try:
            async with self._client_factory() as client:
                response = await client.get(f"{self.base_url}/v1/models", headers=self._headers())
        except httpx.ConnectError:
            raise ProviderError(self._connect_error_message(), **self._unreachable())
        except httpx.HTTPError as exc:
            raise ProviderError(f"Network error: {exc}",
                                **failure(NETWORK_ERROR, upstream=str(exc)))
        if response.status_code >= 400:
            detail = _error_text(response.content, quote_a_page=True)
            raise ProviderError(
                f"Anthropic error ({response.status_code}): {excerpt(response.text, 200)}",
                **status_failure(response.status_code, detail),
            )
        try:
            return [m["id"] for m in response.json().get("data") or [] if m.get("id")]
        except (ValueError, KeyError, TypeError, AttributeError):
            raise ProviderError("Unexpected response from Anthropic on /v1/models.",
                                **failure(UNEXPECTED_RESPONSE))


async def _read_error(response: httpx.Response) -> str:
    return _error_text(await response.aread())


def _error_text(content: bytes, *, quote_a_page: bool = False) -> str:
    """What the server said about the error, from the body it sent. A body that
    is not JSON, such as the page a proxy in front of the server answers with, is
    quoted if asked to (a short excerpt of it) and otherwise said to be nothing."""
    try:
        body = json.loads(content)
        error = body.get("error")
        if isinstance(error, dict):
            return error.get("message") or str(error)
        return str(error or "")[:300]
    except (ValueError, AttributeError):
        return excerpt(content.decode("utf-8", "replace")) if quote_a_page else ""
