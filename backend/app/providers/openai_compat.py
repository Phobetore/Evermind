"""OpenAI-compatible chat completions provider.

Covers Ollama, LM Studio, llama.cpp server, KoboldCpp, vLLM, OpenRouter,
OpenAI, Groq, Mistral, DeepSeek, Together — anything speaking
`POST {base_url}/chat/completions` with SSE streaming.
"""

from collections.abc import AsyncIterator
from contextlib import aclosing

from ..prompting.engine import PromptPayload
from .base import Provider, ProviderError, ProviderEvent, words_of

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
        usage = stop = None
        async with aclosing(self._sse("/chat/completions", self._build_body(payload))) as events:
            async for event in events:
                if event.get("error"):
                    raise ProviderError(words_of(event))
                usage = event.get("usage") or usage
                choice = (event.get("choices") or [{}])[0]
                if not isinstance(choice, dict):
                    continue
                stop = choice.get("finish_reason") or stop
                delta = choice.get("delta") or {}
                # Servers that show a model's reasoning do not agree on where they put it.
                thought = delta.get("reasoning_content") or delta.get("reasoning")
                if isinstance(thought, str) and thought:
                    yield ProviderEvent(type="thought", count=len(thought))
                text = delta.get("content")
                if text:
                    yield ProviderEvent(type="delta", text=text)
        yield ProviderEvent(type="done", usage=usage,
                            stop=str(stop) if stop is not None else None)
