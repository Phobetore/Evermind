"""Application errors mapped to structured JSON responses."""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    status_code = 400

    def __init__(self, message: str, status_code: int | None = None,
                 kind: str | None = None):
        super().__init__(message)
        self.message = message
        # A name for what went wrong, where the interface has something better
        # to show than the sentence. "unreachable" means the model never
        # answered, which reads very differently from a mistake someone made.
        self.kind = kind
        if status_code is not None:
            self.status_code = status_code


class NotFoundError(AppError):
    status_code = 404


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        body = {"error": exc.message}
        if exc.kind:
            body["kind"] = exc.kind
        return JSONResponse(status_code=exc.status_code, content=body)
