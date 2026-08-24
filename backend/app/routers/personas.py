import aiosqlite
from fastapi import APIRouter, Depends, UploadFile

from ..db import get_db
from ..errors import NotFoundError
from ..models.schemas import PersonaIn, PersonaUpdate
from ..repositories import personas as repo
from ..repositories import settings as settings_repo
from ..services import media

router = APIRouter(prefix="/api/personas", tags=["personas"])


@router.get("")
async def list_personas(db: aiosqlite.Connection = Depends(get_db)):
    return await repo.list_all(db)


@router.post("", status_code=201)
async def create_persona(payload: PersonaIn, db: aiosqlite.Connection = Depends(get_db)):
    return await repo.create(db, payload.model_dump())


@router.put("/{persona_id}")
async def update_persona(persona_id: str, payload: PersonaUpdate,
                         db: aiosqlite.Connection = Depends(get_db)):
    updated = await repo.update(db, persona_id, payload.model_dump(exclude_unset=True))
    if not updated:
        raise NotFoundError("Persona not found.")
    return updated


@router.delete("/{persona_id}", status_code=204)
async def delete_persona(persona_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await repo.delete(db, persona_id):
        raise NotFoundError("Persona not found.")
    await settings_repo.forget(db, "default_persona_id", persona_id)


@router.post("/{persona_id}/avatar")
async def upload_avatar(persona_id: str, file: UploadFile,
                        db: aiosqlite.Connection = Depends(get_db)):
    previous = (await repo.get(db, persona_id) or {}).get("avatar_url") or ""
    data, extension = await media.read_image_upload(file)
    filename = media.save(data, extension)
    updated = await repo.update(db, persona_id, {"avatar_path": filename})
    if not updated:
        raise NotFoundError("Persona not found.")
    await media.forget(db, previous.removeprefix("/api/media/"))
    return updated
