"""Middleware for observability and request protection.

* **RequestIDMiddleware** – assigns a unique ``X-Request-ID`` to every incoming
  request so that logs, errors, and responses can be correlated.
* **RateLimitMiddleware** – simple in-memory sliding-window rate limiter keyed
  by client IP.  Returns ``429 Too Many Requests`` when the limit is exceeded.
"""

from __future__ import annotations

import time
import uuid
from collections import defaultdict, deque
from typing import TYPE_CHECKING

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse

if TYPE_CHECKING:
    from starlette.requests import Request
    from starlette.responses import Response

REQUEST_ID_HEADER = "X-Request-ID"

# ---------------------------------------------------------------------------
# Request-ID middleware
# ---------------------------------------------------------------------------


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Inject and propagate a request identifier."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())
        # Store on request state so handlers/services can access it
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers[REQUEST_ID_HEADER] = request_id
        return response


# ---------------------------------------------------------------------------
# Rate-limit middleware
# ---------------------------------------------------------------------------

# Default settings — generous for local usage, sufficient to prevent abuse.
DEFAULT_MAX_REQUESTS = 100  # requests per window
DEFAULT_WINDOW_SECONDS = 60  # sliding window duration


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window rate limiter keyed by client IP.

    Parameters
    ----------
    app:
        The ASGI application.
    max_requests:
        Maximum number of requests allowed per *window_seconds* per client IP.
    window_seconds:
        Duration of the sliding window in seconds.
    """

    def __init__(
        self,
        app,  # noqa: ANN001  — BaseHTTPMiddleware typing
        max_requests: int = DEFAULT_MAX_REQUESTS,
        window_seconds: int = DEFAULT_WINDOW_SECONDS,
    ) -> None:
        super().__init__(app)
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        # {client_ip: deque([timestamp, ...])}
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def _client_ip(self, request: Request) -> str:
        """Extract the client IP from the request."""
        if request.client:
            return request.client.host
        return "unknown"

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        client_ip = self._client_ip(request)
        now = time.monotonic()
        cutoff = now - self.window_seconds

        # Prune timestamps outside the current window (O(1) per removal)
        timestamps = self._hits[client_ip]
        while timestamps and timestamps[0] <= cutoff:
            timestamps.popleft()

        if len(timestamps) >= self.max_requests:
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests", "status": 429},
            )

        timestamps.append(now)
        return await call_next(request)

    def reset(self) -> None:
        """Clear all tracked request timestamps (useful for testing)."""
        self._hits.clear()
