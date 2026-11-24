"""Evermind backend application."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.middleware.gzip import GZipMiddleware

from . import __version__, config, gate, headers, log_file
from .db import init_db
from .errors import register_error_handlers
from .ui import UIFiles


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    # So that an old password, set again later, lets in no device from before.
    await gate.end_sessions_if_the_password_changed()
    import asyncio

    from .db import connect
    from .repositories import connections
    from .services import limits, memory_service

    db = await connect()
    try:
        # The release before may have made a service, or moved one, since this one last ran.
        await connections.name_families(db)
    finally:
        await db.close()
    filling = asyncio.create_task(memory_service.fill_vectors())
    yield
    # Ended first, so that it hands no thread new work once the threads are waited for, below.
    filling.cancel()
    await asyncio.wait([filling])
    # A read of a slow server's list would hold the stop for a minute: what it read is not needed.
    await limits.drain(cancel=True)
    # A Remember or a consolidation outlives its request, not the server: ended whole, not half-written.
    await memory_service.stop()
    # A task cancelled leaves its thread running: the semantic model loading, a vector being worked
    # out. Ctrl+Break ends the process as soon as this returns, without waiting for them as Ctrl+C
    # does, and a thread ended in the middle of loading a library leaves the process unable to end.
    await asyncio.get_running_loop().shutdown_default_executor()


def create_app() -> FastAPI:
    log_file.install()
    # No /docs, /redoc or /openapi.json: they sit outside /api/, where the gate lets everything through.
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
