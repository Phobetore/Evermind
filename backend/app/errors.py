"""Application errors mapped to structured JSON responses.

The ``error`` sentence is English, for whoever reads the API. The interface
reads ``kind`` instead, and says it in the person's own language.
"""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

# A model's server that failed and said why: the sentence is its own, so it is worth showing.
MODEL_ERROR = "model_error"
# A reply that came back, but with nothing in it.
MODEL_EMPTY = "model_empty"
# A reply that came back, but not in a shape that could be used.
MODEL_UNREADABLE = "model_unreadable"
NO_CONNECTION = "no_connection"
NOT_FOUND = "not_found"
# A turn was asked for while a different one was being written.
TURN_RUNNING = "turn_running"
# A fact was given with no text in it, to add or to be rewritten as.
FACT_EMPTY = "fact_empty"
# A memory task that kept nothing: another ran, what it read changed, or too few facts to merge.
MEMORY_BUSY = "memory_busy"
FACTS_CHANGED = "facts_changed"
CONVERSATION_CHANGED = "conversation_changed"
TOO_FEW_FACTS = "too_few_facts"


class AppError(Exception):
    status_code = 400

    def __init__(self, message: str, status_code: int | None = None,
                 kind: str | None = None, resource: str | None = None):
        super().__init__(message)
        self.message = message
        # A name for what went wrong, which the interface has a sentence for in
        # every language. "unreachable" means the model never answered, which
        # reads very differently from a mistake someone made.
        self.kind = kind
        # What a "not_found" did not find: "character", "conversation"...
        self.resource = resource
        if status_code is not None:
            self.status_code = status_code


class NotFoundError(AppError):
    status_code = 404

    def __init__(self, message: str, resource: str):
        super().__init__(message, kind=NOT_FOUND, resource=resource)


def error_body(exc: AppError) -> dict:
    body = {"error": exc.message}
    if exc.kind:
        body["kind"] = exc.kind
    if exc.resource:
        body["resource"] = exc.resource
    return body


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        if exc.status_code >= 500:
            # The access line says 502 and no more, and three different causes give it.
            # Not imported from providers, which imports this file: only a ProviderError has a status.
            upstream = getattr(exc, "status", None)
            logger.warning("%s %s failed with %s: %s%s", request.method, request.url.path, exc.kind,
                           exc.message, f" (the model's server answered {upstream})" if upstream else "")
        return JSONResponse(status_code=exc.status_code, content=error_body(exc))

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, exc: RequestValidationError) -> JSONResponse:
        # FastAPI's own echoes what was sent, which can be anything, nested thousands deep.
        problems = [{key: error[key] for key in ("type", "loc", "msg")} for error in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": problems})
