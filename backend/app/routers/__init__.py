import sys

from fastapi import APIRouter, FastAPI

from .. import __version__, config

health_router = APIRouter()


@health_router.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "app": "evermind", "version": __version__}


@health_router.get("/api/update")
async def update() -> dict:
    """What only the server knows for the notice of a newer release: the browser asks GitHub."""
    kind = config.install_kind()
    if kind == "docker":
        command = "docker compose up -d --pull always"
    elif kind == "zip":
        command = None  # Settings links to INSTALL.md, which says what to copy across
    elif sys.platform == "win32":
        command = r"git pull; .\scripts\prod.ps1"  # Windows PowerShell has no &&
    else:
        command = "git pull && ./scripts/prod.sh"
    return {"current": __version__, "command": command}


def register_routers(app: FastAPI) -> None:
    from . import (
        characters,
        chat,
        connections,
        conversations,
        gate,
        library,
        media,
        memories,
        personas,
        settings_router,
    )

    app.include_router(health_router)
    app.include_router(gate.router)
    app.include_router(chat.router)
    app.include_router(memories.router)
    app.include_router(library.router)
    app.include_router(characters.router)
    app.include_router(personas.router)
    app.include_router(connections.router)
    app.include_router(conversations.router)
    app.include_router(settings_router.router)
    app.include_router(media.router)
