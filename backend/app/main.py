"""Evermind backend application."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import init_db
from .errors import register_error_handlers


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    import asyncio

    from .services import memory_service
    asyncio.create_task(memory_service.warmup_and_backfill())
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="Evermind", version="2.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_error_handlers(app)

    from .routers import register_routers

    register_routers(app)
    return app


app = create_app()
