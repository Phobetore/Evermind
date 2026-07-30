"""Common provider contract: normalized streaming events."""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Literal

import httpx

from ..prompting.engine import PromptPayload

# Local generation can be slow: generous read timeout, snappy connect timeout.
# read is per-chunk, but the FIRST token after a long prompt-eval on big
# CPU-offloaded models (70B hybrid) can take many minutes — hence 900s.
DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=900.0, write=30.0, pool=30.0)


@dataclass
class ProviderEvent:
    type: Literal["delta", "done", "error"]
    text: str = ""
    message: str = ""
    usage: dict | None = None
    meta: dict = field(default_factory=dict)


class ProviderError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class Provider:
    """One instance per configured connection."""

    def __init__(self, connection: dict):
        self.connection = connection
        self.base_url = (connection.get("base_url") or "").rstrip("/")
        self.api_key = connection.get("api_key") or ""
        self.model = connection.get("model") or ""
        self._client_factory = lambda: httpx.AsyncClient(timeout=DEFAULT_TIMEOUT)

    async def stream_chat(self, payload: PromptPayload) -> AsyncIterator[ProviderEvent]:
        raise NotImplementedError
        yield  # pragma: no cover

    async def list_models(self) -> list[str]:
        raise NotImplementedError

    async def test(self) -> dict:
        """Cheap reachability/auth check used by the connections UI."""
        try:
            models = await self.list_models()
            return {"ok": True, "detail": f"{len(models)} models available", "models_sample": models[:8]}
        except ProviderError as exc:
            return {"ok": False, "detail": exc.message}

    def _connect_error_message(self) -> str:
        return (
            f"Cannot reach {self.base_url or 'the server'}. "
            "Check that the server is running and the URL is correct."
        )
