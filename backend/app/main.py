"""Evermind backend application."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.middleware.gzip import GZipMiddleware

from . import __version__, config, gate, headers, journal
from .db import init_db
from .errors import register_error_handlers
from .ui import UIFiles


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Before anything can go wrong: what the last run kept, and a word now if its file is unreadable.
    journal.current.load()
    await init_db()
    # So that an old password, set again later, lets in no device from before.
    await gate.end_sessions_if_the_password_changed()
    import asyncio

    from .services import memory_service
    asyncio.create_task(memory_service.fill_vectors())
    yield


def create_app() -> FastAPI:
    # No /docs, /redoc or /openapi.json: they sit outside /api/, where the gate lets everything through.
    journal.install()
    app = FastAPI(title="Evermind", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    # No CORS: the interface is never on another origin, and other origins' writes are refused here.
    app.add_middleware(gate.GateMiddleware)
    # Starlette leaves out the event stream, and pictures that are compressed already.
    app.add_middleware(GZipMiddleware)
    # The last added is the first to get the request and the last to touch the answer, so the
    # gate's refusals carry the headers too.
    app.add_middleware(headers.SecurityHeaders)
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
