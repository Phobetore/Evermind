import aiosqlite
from fastapi import APIRouter, Depends, FastAPI

from .. import __version__
from ..db import get_db
from ..repositories import settings as settings_repo
from ..services import update_check

health_router = APIRouter()


@health_router.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "app": "evermind", "version": __version__}


@health_router.get("/api/update")
async def update(db: aiosqlite.Connection = Depends(get_db)) -> dict:
    stored = await settings_repo.get_all(db)
    return await update_check.check(enabled=bool(stored["update_check"]))


def register_routers(app: FastAPI) -> None:
    from . import (
        characters,
        chat,
        connections,
        conversations,
        library,
        lore,
        media,
        memories,
        personas,
        settings_router,
    )

    app.include_router(health_router)
    app.include_router(chat.router)
    app.include_router(memories.router)
    app.include_router(lore.router)
    app.include_router(library.router)
    app.include_router(characters.router)
    app.include_router(personas.router)
    app.include_router(connections.router)
    app.include_router(conversations.router)
    app.include_router(settings_router.router)
    app.include_router(media.router)
