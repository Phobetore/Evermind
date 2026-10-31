"""Common provider contract: normalized streaming events."""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Literal

import httpx

from ..errors import failure_fields
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


# The kinds of failure between Evermind and a model's server. The sentences stay
# English here, for whoever reads the API; the interface says each in the
# person's own language.
UNREACHABLE = "unreachable"
AUTH_REFUSED = "model_auth_refused"
MODEL_NOT_FOUND = "model_not_found"
RATE_LIMITED = "model_rate_limited"
HTTP_ERROR = "model_http_error"
TIMEOUT = "model_timeout"
NETWORK_ERROR = "model_network_error"
UNEXPECTED_RESPONSE = "model_unexpected_response"
UNKNOWN_TYPE = "model_unknown_type"
NO_TEXT = "model_no_text"


def failure(kind: str, **details) -> dict:
    """The ``meta`` of a failed event, or the keyword arguments of a
    ``ProviderError``: a kind, and what the model's server said (``upstream``,
    ``upstream_status``) if it did. Empty details are left out."""
    return {"kind": kind, **{k: v for k, v in details.items() if v not in (None, "")}}


def status_failure(status: int, detail: str) -> dict:
    """The failure for a model's server that answered with an error status."""
    kind = {401: AUTH_REFUSED, 404: MODEL_NOT_FOUND, 429: RATE_LIMITED}.get(status, HTTP_ERROR)
    return failure(kind, upstream_status=status, upstream=detail)


class ProviderError(Exception):
    def __init__(self, message: str, kind: str | None = None, **details):
        super().__init__(message)
        self.message = message
        self.kind = kind
        self.details = details

    @property
    def meta(self) -> dict:
        """What a failed event would carry, with the kind a model gets when it
        gives none."""
        return failure_fields({"kind": self.kind, **self.details})


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
            return {"ok": True, "detail": f"{len(models)} models available",
                    "model_count": len(models), "models_sample": models[:8]}
        except ProviderError as exc:
            return {"ok": False, "detail": exc.message, **exc.meta}

    def _connect_error_message(self) -> str:
        return (
            f"Cannot reach {self.base_url or 'the server'}. "
            "Check that the server is running and the URL is correct."
        )
