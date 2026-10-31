"""The built interface, served from the same port as the API.

One process and one address mean the interface never makes a cross-origin
request, so the API sends no CORS headers, and a phone on the local network
needs a single URL.
"""

import errno
import logging
import os
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import RedirectResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import Receive, Scope, Send

logger = logging.getLogger(__name__)

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
    "/characters",
    "/characters/{rest:path}",
    "/personas",
    "/personas/",
    "/settings",
    "/settings/",
    "/login",
    "/login/",
)
# What a URL may keep as it is, which is what RedirectResponse leaves alone too:
# the "%" of what is already encoded and the characters set aside as separators.
_URL_SAFE = ":/%#?=@[]!$&'()*+,;"
# The same for a path that has been decoded, where "%", "?" and "#" are part of a
# name and not what they stand for in a URL.
_DECODED_SAFE = "/:@!$&'()*+,;="
# What the file system answers to a name it cannot have: Windows says "invalid
# argument" (WinError 123) for ``*``, ``"`` or a line break, and any system says
# "name too long".
_REFUSED_NAME = {errno.EINVAL, errno.ENAMETOOLONG}


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
        try:
            response = await super().get_response(path, scope)
        except OSError as err:
            # A name that no file can have is a file that is not there. Any
            # other failure is the disk's and has to show as one.
            if err.errno not in _REFUSED_NAME:
                logger.error("Could not look up %s in the interface folder: %s", path, err)
                raise
            raise HTTPException(status_code=404) from None
        # Only a file that was found may be called immutable: an error page
        # cached for a year would outlive the fix.
        if top == "assets" and response.status_code in (200, 304):
            response.headers["Cache-Control"] = IMMUTABLE
        else:
            response.headers["Cache-Control"] = REVALIDATE
        return response


async def _redirect_legacy(request: Request) -> RedirectResponse:
    scope = request.scope
    # The path as the client wrote it. Decoded, a "%3F" would turn into the "?"
    # that starts a query and a "%23" into the "#" that starts a fragment, and
    # the redirect would lead to another route.
    raw_path = scope.get("raw_path")
    if raw_path:
        path = quote(raw_path, safe=_URL_SAFE)
    else:
        # Servers need not send it. The decoded path says less: what it holds
        # is encoded again, so that a "%" stays a "%" and a "?" a "?".
        path = quote(scope["path"], safe=_DECODED_SAFE)
    # Behind a prefix (``uvicorn --root-path``) the interface lives under it, so
    # the "#" goes after the prefix, and the route is what comes after that. The
    # server may or may not have put the prefix in the path.
    prefix = quote(scope.get("root_path", "").rstrip("/"), safe=_DECODED_SAFE)
    if prefix and path.startswith(prefix) and path[len(prefix):][:1] in ("", "/"):
        path = path[len(prefix):]
    target = f"{prefix}/#{path}"
    # The query goes through as it came: the login page's ``from`` is already
    # encoded, and encoding it again would make it point somewhere else. It is
    # not read from request.url, which is rebuilt from the decoded path and would
    # take the part after a "%3F" in it for the query.
    if query := scope.get("query_string"):
        target += "?" + quote(query, safe=_URL_SAFE)
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
