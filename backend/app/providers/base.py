"""What every provider shares: the request to a model's server, its stream, and how it fails."""

import json
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass
from typing import Literal

import httpx

from ..errors import MODEL_ERROR, MODEL_UNREADABLE, AppError
from ..prompting.engine import PromptPayload

# Local generation can be slow: generous read timeout, snappy connect timeout.
# read is per-chunk, but the FIRST token after a long prompt-eval on big
# CPU-offloaded models (70B hybrid) can take many minutes — hence 900s.
DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=900.0, write=30.0, pool=30.0)

# How a model's server failed, besides MODEL_ERROR, which is its own complaint.
UNREACHABLE = "unreachable"
CONNECTION_LOST = "model_connection_lost"
AUTH_REFUSED = "model_auth_refused"
MODEL_NOT_FOUND = "model_not_found"
RATE_LIMITED = "model_rate_limited"
NO_TEXT = "model_no_text"


@dataclass
class ProviderEvent:
    type: Literal["delta", "done"]
    text: str = ""
    usage: dict | None = None


class ProviderError(AppError):
    """A model's server that failed: ``message`` is what it said, or the address it could not be
    reached at, and ``status`` the error status it answered with, if it did."""

    def __init__(self, message: str, kind: str = MODEL_ERROR, status: int | None = None):
        super().__init__(message, 502, kind=kind)
        self.status = status


def words_of(said: object) -> str:
    """What a model's server said of an error, from the JSON it sent: its message, if it gave one."""
    if isinstance(said, dict):
        said = said.get("error", said)
    if isinstance(said, dict):
        said = said.get("message") or said
    return str(said)[:300] if said else ""


def _refusal(status: int, body: bytes) -> ProviderError:
    try:
        words = words_of(json.loads(body))
    except ValueError:
        words = ""
    kind = {401: AUTH_REFUSED, 404: MODEL_NOT_FOUND, 429: RATE_LIMITED}.get(status, MODEL_ERROR)
    return ProviderError(words or f"HTTP {status}", kind, status)


class Provider:
    """Built from a connection's settings for each use of it."""

    MODELS = "/models"  # where the server lists its models, after base_url

    def __init__(self, connection: dict):
        self.connection = connection
        self.base_url = (connection.get("base_url") or "").rstrip("/")
        self.api_key = connection.get("api_key") or ""
        self.model = connection.get("model") or ""
        self._client_factory = lambda: httpx.AsyncClient(timeout=DEFAULT_TIMEOUT)

    def _headers(self) -> dict:
        raise NotImplementedError

    async def stream_chat(self, payload: PromptPayload) -> AsyncIterator[ProviderEvent]:
        """The reply as it arrives, then its end. A failure raises a ProviderError."""
        raise NotImplementedError
        yield  # pragma: no cover

    async def list_models(self) -> list[str]:
        try:
            async with self._client_factory() as client:
                response = await client.get(self.base_url + self.MODELS, headers=self._headers())
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise self._lost(exc)
        if response.status_code >= 400:
            raise _refusal(response.status_code, response.content)
        try:
            models = response.json().get("data") or []
            return [m["id"] for m in models if isinstance(m, dict) and m.get("id")]
        except (ValueError, AttributeError, TypeError):
            raise ProviderError("The list of models could not be read.", MODEL_UNREADABLE)

    async def _sse(self, path: str, body: dict) -> AsyncIterator[dict]:
        """The objects of the server's event stream, until it says [DONE] or ends."""
        try:
            async with self._client_factory() as client, client.stream(
                "POST", self.base_url + path, headers=self._headers(), json=body,
            ) as response:
                if response.status_code >= 400:
                    raise _refusal(response.status_code, await response.aread())
                async for line in response.aiter_lines():
                    data = line[5:].strip() if line.startswith("data:") else ""
                    if data == "[DONE]":
                        return
                    try:
                        event = json.loads(data)
                    except ValueError:
                        continue
                    if isinstance(event, dict):
                        yield event
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise self._lost(exc)

    def _lost(self, exc: Exception) -> ProviderError:
        """A request that never reached the server, or that broke off on the way."""
        if isinstance(exc, httpx.ConnectError | httpx.ConnectTimeout
                      | httpx.UnsupportedProtocol | httpx.InvalidURL):
            return ProviderError(self.base_url, UNREACHABLE)
        message = str(exc) or "The connection to the model's server was lost."
        return ProviderError(message, CONNECTION_LOST)


async def complete(provider: Provider, payload: PromptPayload) -> str:
    """A model's whole answer, for a caller that has no use for it as it arrives."""
    async with aclosing(provider.stream_chat(payload)) as stream:
        return "".join([event.text async for event in stream])
