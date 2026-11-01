"""Common provider contract: normalized streaming events."""

import html
import re
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


# What reads as markup: an XML prolog, a comment, a script or a style with its
# content, or a tag. A "<" followed by a space or a digit is a comparison, not a tag.
# A script or a style with no end in the part that is looked at (\Z) goes to the end
# of it: what is left of a block that was cut off is code, not words. So the name has
# to end where a tag's name ends (whitespace, "/", ">" or the end of what is looked
# at): <style-guide> is a tag like any other, and taken for a block that never closes
# it would take the rest of the page with it.
_PROLOG = re.compile(r"<\?.*?\?>", re.DOTALL)
_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_SCRIPT_OR_STYLE = re.compile(
    r"<(script|style)(?=[\s>/]|\Z).*?(?:</\1\s*>|\Z)", re.DOTALL | re.IGNORECASE
)
_TAG = re.compile(r"</?[A-Za-z!][^>]*>")
# How much of an answer is looked at. The words of an error page are at its
# start, and this runs on the event loop that live replies are streamed on, so
# the work is bounded by this and not by what the server sent.
_EXCERPT_SCAN = 4000


def excerpt(text: str, limit: int = 300) -> str:
    """The start of what a server answered, as words on one line: if it is a
    page, the page without its markup, since "502 Bad Gateway" is what the person
    needs and "<html><body><h1>" is noise."""
    text = text[:_EXCERPT_SCAN]
    for markup in (_PROLOG, _COMMENT, _SCRIPT_OR_STYLE, _TAG):
        text = markup.sub(" ", text)
    return " ".join(html.unescape(text).split())[:limit]


_USERINFO = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*://)[^/?#]*@")


def without_userinfo(url: str) -> str:
    """The address without a ``user:password@`` part. That is a secret, and an
    error that names the address must not carry it out of the server."""
    return _USERINFO.sub(r"\1", url)


def failure(kind: str, **details) -> dict:
    """The ``meta`` of a failed event, or the keyword arguments of a
    ``ProviderError``: a kind, and what the model's server said (``upstream``,
    ``upstream_status``) or the address that could not be reached
    (``upstream_url``), if there is one. Empty details are left out."""
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
    """Built from a connection's settings for each use of it."""

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
            f"Cannot reach {without_userinfo(self.base_url) or 'the server'}. "
            "Check that the server is running and the URL is correct."
        )

    def _unreachable(self) -> dict:
        """The failure of a server that cannot be reached, with where it was tried."""
        return failure(UNREACHABLE, upstream_url=without_userinfo(self.base_url))
