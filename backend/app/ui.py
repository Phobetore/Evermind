"""The built interface, served from the same port as the API, so the interface
never makes a cross-origin request and a phone on the network needs one URL."""

import errno
import logging
import os
from urllib.parse import quote

from starlette.exceptions import HTTPException
from starlette.responses import RedirectResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

# Vite puts a hash of the content in the name of everything under /assets/, so a
# file there never changes under its name. Everything else keeps its name from
# one build to the next, and no-cache makes a phone with an old copy ask again.
IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"

# The pages of the 2.x interface, which phones still have as bookmarks. The
# current one routes on the part after "#".
_OLD_PAGES = {"chat", "characters", "personas", "settings", "login"}
# What the file system answers to a name it cannot have (Windows: ``*`` or ``"``).
_REFUSED_NAME = {errno.EINVAL, errno.ENAMETOOLONG}


class _WithoutChromeProbe(logging.Filter):
    """DevTools asks every page for this address; the 404 is right but reads like a fault."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "/.well-known/appspecific/com.chrome.devtools.json" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_WithoutChromeProbe())


class UIFiles(StaticFiles):
    """Static files with the cache rules above, and the old links sent to the new routes."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        top = path.split(os.sep, 1)[0]  # ``path`` is normalised: parts are joined by os.sep
        try:
            if top == "api":
                # Whatever no route of the API answered gets the API's own 404.
                raise HTTPException(status_code=404)
            response = await super().get_response(path, scope)
        except HTTPException as err:
            if err.status_code != 404 or top not in _OLD_PAGES:
                raise
            query = scope["query_string"].decode("latin-1")
            return RedirectResponse(f"/#{quote(scope['path'])}" + (f"?{query}" if query else ""), 302)
        except OSError as err:
            if err.errno not in _REFUSED_NAME:
                raise
            raise HTTPException(status_code=404) from None
        # Only a file that was found may be called immutable.
        found = top == "assets" and response.status_code in (200, 304)
        response.headers["Cache-Control"] = IMMUTABLE if found else REVALIDATE
        return response
