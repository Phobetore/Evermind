"""OpenAI-compatible chat completions provider.

Covers Ollama, LM Studio, llama.cpp server, KoboldCpp, vLLM, OpenRouter,
OpenAI, Groq, Mistral, DeepSeek, Together — anything speaking
`POST {base_url}/chat/completions` with SSE streaming.
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

# Each is sent only when the connection holds a value: empty leaves it to the model.
SAMPLING = ("max_tokens", "temperature", "top_p", "frequency_penalty", "presence_penalty")


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
            **{key: conn[key] for key in SAMPLING if conn.get(key) is not None},
        }
        # OpenAI's newest models refuse it; trim_reply cuts the saved reply there instead.
        if payload.stop and "api.openai.com" not in self.base_url:
            body["stop"] = payload.stop[:4]
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
                    yield ProviderEvent(
                        type="error",
                        message=_http_error_message(response.status_code, detail, self.model),
                        meta=status_failure(response.status_code, detail),
                    )
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
                    if obj.get("error"):
                        yield ProviderEvent(type="error", message=_error_text(data.encode()),
                                            meta=failure(MODEL_ERROR))
                        return
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
            yield ProviderEvent(type="error", message=self._connect_error_message(),
                                meta=self._unreachable())
            return
        except httpx.TimeoutException:
            yield ProviderEvent(type="error",
                                message="The LLM server took too long to respond (timeout).",
                                meta=failure(TIMEOUT))
            return
        except httpx.HTTPError as exc:
            yield ProviderEvent(type="error", message=f"Network error: {exc}",
                                meta=failure(NETWORK_ERROR, upstream=str(exc)))
            return
        yield ProviderEvent(type="done", usage=usage, meta={"finish_reason": finish_reason})

    async def list_models(self) -> list[str]:
        try:
            async with self._client_factory() as client:
                response = await client.get(f"{self.base_url}/models", headers=self._headers())
        except httpx.ConnectError:
            raise ProviderError(self._connect_error_message(), **self._unreachable())
        except httpx.HTTPError as exc:
            raise ProviderError(f"Network error: {exc}",
                                **failure(NETWORK_ERROR, upstream=str(exc)))
        if response.status_code >= 400:
            detail = _error_text(response.content, quote_a_page=True)
            raise ProviderError(
                _http_error_message(response.status_code, detail, self.model),
                **status_failure(response.status_code, detail),
            )
        try:
            data = response.json().get("data") or []
            return [m["id"] for m in data if isinstance(m, dict) and m.get("id")]
        except (ValueError, KeyError, TypeError):
            raise ProviderError("Unexpected server response on /models.",
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
        return str(error or body)[:300]
    except (ValueError, AttributeError):
        return excerpt(content.decode("utf-8", "replace")) if quote_a_page else ""


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
