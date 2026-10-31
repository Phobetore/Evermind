"""The built interface, served from the same port as the API.

One process and one address mean the interface never makes a cross-origin
request, so the API sends no CORS headers, and a phone on the local network
needs a single URL.
"""

import os
from pathlib import Path

from fastapi import FastAPI
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import RedirectResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import Receive, Scope, Send

# Vite puts a hash of the content in the name of everything under /assets/, so
# a file there never changes under its name and can be kept for good.
IMMUTABLE = "public, max-age=31536000, immutable"
# Everything else keeps its name from one build to the next, index.html first.
# no-cache lets the browser keep a copy but makes it ask before using it, which
# is what lets a phone that has an old interface pick up a new one.
REVALIDATE = "no-cache"

# The paths the previous interface lived at, which phones still have as
# bookmarks. The new one routes on the part after "#".
LEGACY_PATHS = (
    "/chat",
    "/chat/{rest:path}",
    "/characters/{rest:path}",
    "/personas",
    "/settings",
    "/login",
)


class UIFiles(StaticFiles):
    """Static files with the cache rules above."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        # ``path`` is normalised, so its parts are separated by os.sep.
        top = path.split(os.sep, 1)[0]
        if top == "api":
            # The router hands this class every path that no route answered,
            # the API's included, and a client that expects JSON from /api/
            # should get the API's own 404. This is also decided before the
            # method is checked, which would otherwise turn a POST into a 405.
            raise HTTPException(status_code=404)
        response = await super().get_response(path, scope)
        # Only a file that was found may be called immutable: an error page
        # cached for a year would outlive the fix.
        if top == "assets" and response.status_code in (200, 304):
            response.headers["Cache-Control"] = IMMUTABLE
        else:
            response.headers["Cache-Control"] = REVALIDATE
        return response


def _redirect_legacy(request: Request) -> RedirectResponse:
    # The query goes through as it came: the login page's ``from`` is already
    # encoded, and encoding it again would make it point somewhere else.
    target = "/#" + request.url.path
    if request.url.query:
        target += "?" + request.url.query
    return RedirectResponse(target, status_code=302)


def serve_ui(app: FastAPI, directory: Path) -> None:
    """Serve ``directory`` for every path that no route of ``app`` answers.

    That is the router's fallback rather than a mount on "/", which would take
    the paths of the API's routes along with the rest: a wrong method on a route
    that exists would not be a 405 with its ``Allow`` header, and a missing or
    added trailing slash would not be redirected.
    """
    for pattern in LEGACY_PATHS:
        app.add_route(pattern, _redirect_legacy, methods=["GET"], include_in_schema=False)
    files = UIFiles(directory=directory, html=True)
    not_found = app.router.default

    async def fallback(scope: Scope, receive: Receive, send: Send) -> None:
        # StaticFiles only speaks HTTP. A websocket that no route took is
        # refused the way the router refuses it.
        if scope["type"] == "http":
            await files(scope, receive, send)
        else:
            await not_found(scope, receive, send)

    app.router.default = fallback
