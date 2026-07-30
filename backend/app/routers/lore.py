import aiosqlite
from fastapi import APIRouter, Depends

from ..db import get_db
from ..errors import AppError, NotFoundError
from ..models.schemas import LoreEntryIn, LoreEntryPatch
from ..repositories import characters as characters_repo
from ..repositories import lore as repo

router = APIRouter(prefix="/api", tags=["lore"])


@router.get("/characters/{char_id}/lore")
async def list_lore(char_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await characters_repo.get(db, char_id):
        raise NotFoundError("Character not found.")
    return await repo.list_for_character(db, char_id)


@router.post("/characters/{char_id}/lore", status_code=201)
async def add_lore(char_id: str, payload: LoreEntryIn,
                   db: aiosqlite.Connection = Depends(get_db)):
    if not await characters_repo.get(db, char_id):
        raise NotFoundError("Character not found.")
    saved = await repo.add(db, char_id, keys=payload.keys, content=payload.content,
                           enabled=payload.enabled, case_sensitive=payload.case_sensitive,
                           priority=payload.priority)
    if not saved:
        raise AppError("An entry needs at least one keyword and some content.")
    return saved


@router.patch("/lore/{entry_id}")
async def patch_lore(entry_id: str, payload: LoreEntryPatch,
                     db: aiosqlite.Connection = Depends(get_db)):
    updated = await repo.update(db, entry_id, payload.model_dump(exclude_unset=True))
    if not updated:
        raise NotFoundError("Entry not found.")
    return updated


@router.delete("/lore/{entry_id}", status_code=204)
async def delete_lore(entry_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await repo.delete(db, entry_id):
        raise NotFoundError("Entry not found.")
