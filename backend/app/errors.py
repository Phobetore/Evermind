"""Application errors mapped to structured JSON responses.

The ``error`` sentence is English, for whoever reads the API. The interface
reads ``kind`` instead, and says it in the person's own language.
"""

from fastapi import FastAPI, Request
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


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        body = {"error": exc.message}
        if exc.kind:
            body["kind"] = exc.kind
        if exc.resource:
            body["resource"] = exc.resource
        return JSONResponse(status_code=exc.status_code, content=body)
