"""OpenAI-compatible chat completions provider.

Covers Ollama, LM Studio, llama.cpp server, KoboldCpp, vLLM, OpenRouter,
OpenAI, Groq, Mistral, DeepSeek, Together — anything speaking
`POST {base_url}/chat/completions` with SSE streaming.
"""

import json
from collections.abc import AsyncIterator

import httpx

from ..prompting.engine import PromptPayload
from .base import Provider, ProviderError, ProviderEvent


class OpenAICompatProvider(Provider):
    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _build_messages(self, payload: PromptPayload) -> list[dict]:
        """post_history is suffixed to the last user turn, not sent as a
        trailing system message: local chat templates (Mistral, Metharme…)
        often drop or misplace a system role that appears after the history,
        which silently killed scene directives on LM Studio & co."""
        messages = [{"role": "system", "content": payload.system},
                    *[dict(m) for m in payload.messages]]
        if payload.post_history:
            for message in reversed(messages):
                if message["role"] == "user":
                    message["content"] += f"\n\n{payload.post_history}"
                    return messages
            messages.append({"role": "system", "content": payload.post_history})
        return messages

    def _build_body(self, payload: PromptPayload) -> dict:
        conn = self.connection
        body = {
            "model": self.model,
            "messages": self._build_messages(payload),
            "stream": True,
            "max_tokens": int(conn.get("max_tokens") or 1024),
            "temperature": float(conn.get("temperature") or 0.9),
            "top_p": float(conn.get("top_p") or 0.95),
        }
        for key in ("frequency_penalty", "presence_penalty"):
            value = conn.get(key)
            if value:
                body[key] = float(value)
        if payload.stop:
            body["stop"] = payload.stop[:4]
        extra = conn.get("extra_params") or {}
        if isinstance(extra, dict):
            body.update(extra)
        return body

    async def stream_chat(self, payload: PromptPayload) -> AsyncIterator[ProviderEvent]:
        usage = None
        finish_reason = None
        try:
            async with self._client_factory() as client, client.stream(
                "POST",
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json=self._build_body(payload),
            ) as response:
                if response.status_code >= 400:
                    detail = await _read_error(response)
                    yield ProviderEvent(type="error", message=_http_error_message(
                        response.status_code, detail, self.model))
                    return
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if obj.get("usage"):
                        usage = obj["usage"]
                    choices = obj.get("choices") or []
                    if not choices:
                        continue
                    finish_reason = choices[0].get("finish_reason") or finish_reason
                    text = (choices[0].get("delta") or {}).get("content")
                    if text:
                        yield ProviderEvent(type="delta", text=text)
        except httpx.ConnectError:
            yield ProviderEvent(type="error", message=self._connect_error_message())
            return
        except httpx.TimeoutException:
            yield ProviderEvent(type="error", message="The LLM server took too long to respond (timeout).")
            return
        except httpx.HTTPError as exc:
            yield ProviderEvent(type="error", message=f"Network error: {exc}")
            return
        yield ProviderEvent(type="done", usage=usage, meta={"finish_reason": finish_reason})

    async def list_models(self) -> list[str]:
        try:
            async with self._client_factory() as client:
                response = await client.get(f"{self.base_url}/models", headers=self._headers())
        except httpx.ConnectError:
            raise ProviderError(self._connect_error_message())
        except httpx.HTTPError as exc:
            raise ProviderError(f"Network error: {exc}")
        if response.status_code >= 400:
            raise ProviderError(_http_error_message(response.status_code, response.text[:300], self.model))
        try:
            data = response.json().get("data") or []
            return [m["id"] for m in data if isinstance(m, dict) and m.get("id")]
        except (ValueError, KeyError, TypeError):
            raise ProviderError("Unexpected server response on /models.")


async def _read_error(response: httpx.Response) -> str:
    try:
        body = json.loads(await response.aread())
        error = body.get("error")
        if isinstance(error, dict):
            return error.get("message") or str(error)
        return str(error or body)[:300]
    except (ValueError, AttributeError):
        return ""


def _http_error_message(status: int, detail: str, model: str) -> str:
    if status == 401:
        base = "Authentication refused (401): invalid or missing API key."
    elif status == 404:
        base = f"Endpoint or model not found (404). Check the URL and the model \"{model}\"."
    elif status == 429:
        base = "Rate limit reached (429), try again shortly."
    elif status >= 500:
        base = f"LLM server error ({status})."
    else:
        base = f"LLM server error ({status})."
    return f"{base} {detail}".strip()
