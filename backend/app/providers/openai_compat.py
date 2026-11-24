"""OpenAI-compatible chat completions provider.

Covers Ollama, LM Studio, llama.cpp server, KoboldCpp, vLLM, OpenRouter,
OpenAI, Groq, Mistral, DeepSeek, Together — anything speaking
`POST {base_url}/chat/completions` with SSE streaming.
"""

import asyncio
import logging
import os
import time
import traceback
from collections.abc import AsyncIterator
from contextlib import aclosing

from ..prompting.engine import PromptPayload
from . import catalog
from .base import REFUSED_AS_WRITTEN, Provider, ProviderError, ProviderEvent, scrub, words_of
from .catalog import is_openrouter

logger = logging.getLogger(__name__)

# Each is sent only when the connection holds a value: empty leaves it to the model.
SAMPLING = ("max_tokens", "temperature", "top_p", "frequency_penalty", "presence_penalty")

LIST_KEPT_S = 6 * 3600  # how long a server's list of models is trusted
FAILED_LIST_KEPT_S = 300  # how long a list that could not be read waits to be asked for again
# The list is read in front of a request: one slow to come is not worth holding the request for.
LIST_TIMEOUT_S = 10

_now = time.monotonic
# Per list, as the catalog keeps them: when it last could not be read. The catalog keeps only the
# lists it read, so this is what spares a failing server a request in front of every pass.
_failed_lists: dict[tuple[str, str, catalog.Family, str], float] = {}
# The (base_url, model) pairs whose server refused a "reasoning" field: never sent again to them.
_refused: set[tuple[str, str]] = set()


def least_reasoning(reasoning: object) -> dict | None:
    """The field that asks a model for the least reasoning it allows, from what OpenRouter's list
    says of it, or None when there is nothing to ask for.

    Its "supported_efforts" go from the highest down; null means every effort is taken, and no
    such key means the model gives no choice of effort. A mandatory model refuses "none"."""
    if not isinstance(reasoning, dict):
        return None
    mandatory = reasoning.get("mandatory") is True
    if "supported_efforts" not in reasoning:
        return None if mandatory else {"enabled": False}
    efforts = reasoning["supported_efforts"]
    if efforts is None:
        return {"effort": "minimal" if mandatory else "none"}
    if not isinstance(efforts, list):
        return None
    if not mandatory and "none" in efforts:
        return {"effort": "none"}
    lowest = [effort for effort in efforts if isinstance(effort, str) and effort != "none"]
    if lowest:
        return {"effort": lowest[-1]}
    return None if mandatory else {"enabled": False}


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

    async def _reasoning_field(self) -> dict | None:
        """What to send as "reasoning" for a caller that wants the least of it.

        Only OpenRouter says, model by model, which efforts each accepts. Other servers each
        have their own switch, or none, so they are sent nothing and asked nothing."""
        if not self.connection.get("least_reasoning") or not is_openrouter(self.base_url):
            return None
        if (self.base_url, self.model) in _refused:
            return None
        models = await self._reasoning_of_models()
        if models is None:
            return None
        # A routing suffix (":nitro", ":online") is not a model of its own, unless listed as one.
        model = self.model if self.model in models else self.model.rsplit(":", 1)[0]
        return least_reasoning(models.get(model))

    async def _reasoning_of_models(self) -> dict[str, dict | None] | None:
        """Each listed model's "reasoning" object (None: none given), or None for a list that
        could not be read. Read by the catalog, which keeps one list for every reader of it."""
        key = catalog.cache_key(self.connection)
        failed_at = _failed_lists.get(key)
        if failed_at is not None and _now() - failed_at < FAILED_LIST_KEPT_S:
            return None
        try:
            async with asyncio.timeout(LIST_TIMEOUT_S):
                # The list alone, in one request: the key is not checked here, and a key
                # refused fails the pass itself.
                read = await catalog.read_catalog(
                    self.connection, probes=False, max_age=LIST_KEPT_S, check_key=False,
                    client_factory=self._client_factory)
        except ProviderError as exc:
            logger.warning("the list of models of %s could not be read: %s",
                           self.base_url, exc.message)
        except TimeoutError:
            logger.warning("the list of models of %s did not come within %d seconds",
                           self.base_url, LIST_TIMEOUT_S)
        except Exception as exc:  # noqa: BLE001
            # Whatever else breaks the read, the pass goes out as it did before the list was
            # read: a list the catalog cannot take must never fail every memory pass.
            # Where it was raised, not the traceback: a full one could print the key.
            frame = traceback.extract_tb(exc.__traceback__)[-1] if exc.__traceback__ else None
            where = (f" at {os.path.basename(frame.filename)}:{frame.lineno} in {frame.name}"
                     if frame else "")
            logger.warning("the list of models of %s could not be read: %s", self.base_url,
                           scrub(f"{type(exc).__name__}: {exc}{where}", self.api_key))
        else:
            _failed_lists.pop(key, None)
            return {m.id: m.reasoning for m in read.models}
        _failed_lists[key] = _now()
        return None

    async def _events(self, payload: PromptPayload) -> AsyncIterator[ProviderEvent]:
        body = self._build_body(payload)
        if reasoning := await self._reasoning_field():
            body["reasoning"] = reasoning
        arrived = False
        try:
            async with aclosing(self._read(body)) as events:
                async for event in events:
                    arrived = True
                    yield event
            return
        except ProviderError as exc:
            if "reasoning" not in body or arrived or exc.status not in REFUSED_AS_WRITTEN:
                raise
            refusal = exc.message
        # Asked again without the field. Only an answer then says the field was why: the same
        # refusal again was about something else (the context, the max tokens), and the field,
        # which keeps the bill down, is still sent next time.
        del body["reasoning"]
        async with aclosing(self._read(body)) as events:
            async for event in events:
                if (self.base_url, self.model) not in _refused:
                    _refused.add((self.base_url, self.model))
                    logger.warning("%s refused to be told how much %s should reason (%s), and "
                                   "answered without: it is not told again", self.base_url,
                                   self.model, refusal)
                yield event

    async def _read(self, body: dict) -> AsyncIterator[ProviderEvent]:
        usage = stop = None
        async with aclosing(self._sse("/chat/completions", body)) as events:
            async for event in events:
                if event.get("error"):
                    raise ProviderError(words_of(event, self.api_key))
                usage = event.get("usage") or usage
                choice = (event.get("choices") or [{}])[0]
                if not isinstance(choice, dict):
                    continue
                stop = choice.get("finish_reason") or stop
                delta = choice.get("delta") or {}
                # Servers that show a model's reasoning do not agree on where they put it.
                thought = delta.get("reasoning_content") or delta.get("reasoning")
                if isinstance(thought, str) and thought:
                    yield ProviderEvent(type="thought", text=thought)
                text = delta.get("content")
                if text:
                    yield ProviderEvent(type="delta", text=text)
        yield ProviderEvent(type="done", usage=usage,
                            stop=str(stop) if stop is not None else None)
