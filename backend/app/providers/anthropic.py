"""Anthropic Messages API provider.

Differences handled here: system prompt is a top-level field, messages must
strictly alternate starting with `user` (we merge consecutive same-role turns
and insert a synthetic opener), penalties are unsupported, and
`post_history` is suffixed to the last user message.
"""

from collections.abc import AsyncIterator
from contextlib import aclosing

from ..prompting.engine import PromptPayload
from .base import Provider, ProviderError, ProviderEvent, words_of

API_VERSION = "2023-06-01"


class AnthropicProvider(Provider):
    MODELS = "/v1/models"

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
        # Ending on its own turn asks Claude to complete it, which it refuses from 4.6 on.
        if merged[-1]["role"] == "assistant":
            merged.append({"role": "user", "content": "[Continue.]"})
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
            # Required here, and a model's thinking counts against it.
            "max_tokens": conn.get("max_tokens") or 4096,
            **{key: conn[key] for key in ("temperature", "top_p") if conn.get(key) is not None},
        }
        if payload.stop:
            body["stop_sequences"] = [s for s in payload.stop if s.strip()][:4]
        return body

    async def stream_chat(self, payload: PromptPayload) -> AsyncIterator[ProviderEvent]:
        usage = None
        async with aclosing(self._sse("/v1/messages", self._build_body(payload))) as events:
            async for event in events:
                kind = event.get("type")
                if kind == "content_block_delta":
                    text = (event.get("delta") or {}).get("text")
                    if text:
                        yield ProviderEvent(type="delta", text=text)
                elif kind == "message_delta":
                    usage = event.get("usage") or usage
                elif kind == "error":
                    raise ProviderError(words_of(event))
                elif kind == "message_stop":
                    break
        yield ProviderEvent(type="done", usage=usage)
