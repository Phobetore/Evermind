"""Evermind backend — FastAPI application entry point."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_config
from app.core.database import init_db
from app.core.errors import register_error_handlers
from app.core.logging import setup_logging
from app.routers import characters, chat, conversations, health, memory, messages, models, profiles

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Application startup / shutdown lifecycle."""
    cfg = get_config()
    setup_logging(cfg.logging.level)
    logger.info("Evermind backend starting (port=%s)", cfg.backend_port)
    await init_db()
    logger.info("Database initialised")
    yield
    logger.info("Evermind backend shutting down")


app = FastAPI(
    title="Evermind API",
    version="0.1.0",
    description="AI companion backend — multi-character, long-term memory, text only.",
    lifespan=lifespan,
)

# CORS — allow only the local frontend by default
cfg = get_config()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://127.0.0.1:{cfg.frontend_port}",
        f"http://localhost:{cfg.frontend_port}",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(health.router)
app.include_router(characters.router)
app.include_router(conversations.router)
app.include_router(messages.router)
app.include_router(chat.router)
app.include_router(profiles.router)
app.include_router(memory.router)
app.include_router(models.router)

# Structured error responses
register_error_handlers(app)
