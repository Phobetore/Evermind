"""Every write the API is asked for is told to the turns (services/turns.py), so that the end of a
turn read before it is not handed to a page as what the next turn reads."""

import re

from starlette.types import ASGIApp, Receive, Scope, Send

from .services import turns

_READS = {"GET", "HEAD", "OPTIONS"}
# A turn's own: asking for it, and stopping it, which answers once its end is read.
_TURNS_OWN = re.compile(r"POST /api/chat|DELETE /api/conversations/[^/]+/turn")


class WritesSeen:
    """Pure ASGI, like the gate: a stream goes out as the app sends it."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (scope["type"] != "http" or scope["method"] in _READS
                or not scope["path"].startswith("/api/")
                or _TURNS_OWN.fullmatch(f"{scope['method']} {scope['path']}")):
            await self.app(scope, receive, send)
            return
        # Before and after: an end read while the write was under way did not see all of it.
        turns.wrote()
        try:
            await self.app(scope, receive, send)
        finally:
            turns.wrote()
