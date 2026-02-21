"""Global exception handlers for consistent JSON error responses."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from pydantic import ValidationError

if TYPE_CHECKING:
    from fastapi import FastAPI, Request

logger = logging.getLogger(__name__)


def register_error_handlers(app: FastAPI) -> None:
    """Attach exception handlers that return uniform ``{detail, status}`` bodies."""

    @app.exception_handler(HTTPException)
    async def http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "status": exc.status_code},
        )

    @app.exception_handler(ValidationError)
    async def validation_exception_handler(
        _request: Request, exc: ValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "detail": "Validation error",
                "status": 422,
                "errors": exc.errors(),
            },
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(
        _request: Request, exc: Exception
    ) -> JSONResponse:
        logger.exception("Unhandled exception: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error", "status": 500},
        )
