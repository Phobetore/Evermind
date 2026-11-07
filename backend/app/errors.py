"""Application errors mapped to structured JSON responses.

The ``error`` sentence is English, for whoever reads the API. The interface
reads ``kind`` instead, and says it in the person's own language.
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

# What the model said when it gave no kind of its own: the sentence is the
# model's server's, so it is worth showing as it is.
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

# What a model's server said when it answered with an error, and with which
# status, and the address that could not be reached. The words are its own,
# which Evermind can frame in the person's language but not translate, so they
# travel on their own in an error's fields.
UPSTREAM_FIELDS = ("upstream_status", "upstream", "upstream_url")


def failure_fields(meta: dict) -> dict:
    """The fields that say how a model failed, from the ``meta`` of a failed
    provider event: its kind, "model_error" when it gave none, and whatever its
    server said."""
    fields = {"kind": meta.get("kind") or MODEL_ERROR}
    for name in UPSTREAM_FIELDS:
        if meta.get(name) is not None:
            fields[name] = meta[name]
    return fields


class AppError(Exception):
    status_code = 400

    def __init__(self, message: str, status_code: int | None = None,
                 kind: str | None = None, resource: str | None = None,
                 details: dict | None = None):
        super().__init__(message)
        self.message = message
        # A name for what went wrong, which the interface has a sentence for in
        # every language. "unreachable" means the model never answered, which
        # reads very differently from a mistake someone made.
        self.kind = kind
        # What a "not_found" did not find: "character", "conversation"...
        self.resource = resource
        # More fields for the body, for a kind that has something to add.
        self.details = details or {}
        if status_code is not None:
            self.status_code = status_code


class NotFoundError(AppError):
    status_code = 404

    def __init__(self, message: str, resource: str):
        super().__init__(message, kind=NOT_FOUND, resource=resource)


def model_failure(message: str, meta: dict) -> AppError:
    """The error for a model that failed, from the message and ``meta`` of its
    failed provider event."""
    fields = failure_fields(meta)
    return AppError(message, 502, kind=fields.pop("kind"), details=fields)


def error_body(exc: AppError) -> dict:
    body = {"error": exc.message}
    if exc.kind:
        body["kind"] = exc.kind
    if exc.resource:
        body["resource"] = exc.resource
    body.update(exc.details)
    return body


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=error_body(exc))

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, exc: RequestValidationError) -> JSONResponse:
        # FastAPI's own echoes what was sent, which can be anything, nested thousands deep.
        problems = [{key: error[key] for key in ("type", "loc", "msg")} for error in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": problems})
