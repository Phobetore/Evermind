"""Evermind backend application."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .db import init_db
from .errors import register_error_handlers
from .gate import GateMiddleware, GateStore


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    import asyncio

    from .services import memory_service
    asyncio.create_task(memory_service.warmup_and_backfill())
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="Evermind", version=__version__, lifespan=lifespan)
    # The store loads itself on the first request rather than in the lifespan,
    # which the test client never runs. Added before CORS, which therefore
    # stays outermost and answers preflights, which carry no cookie.
    app.state.gate = GateStore()
    app.add_middleware(GateMiddleware, store=app.state.gate)
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
