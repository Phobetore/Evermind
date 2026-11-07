"""Evermind backend application."""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import __version__, config
from .db import init_db
from .errors import register_error_handlers
from .gate import GateMiddleware
from .ui import UIFiles


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    import asyncio

    from .services import memory_service
    asyncio.create_task(memory_service.warmup_and_backfill())
    yield


def create_app() -> FastAPI:
    # No /docs, /redoc or /openapi.json: they sit outside /api/, where the gate lets everything through.
    app = FastAPI(title="Evermind", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    # No CORS: the interface is never on another origin, and other origins' writes are refused here.
    app.add_middleware(GateMiddleware)
    register_error_handlers(app)

    from .routers import register_routers

    register_routers(app)

    # With no build there is nothing to serve: in development the interface
    # comes from Vite's own server.
    ui = config.ui_dir()
    if (ui / "index.html").is_file():
        app.mount("/", UIFiles(directory=ui, html=True))
    return app


app = create_app()
