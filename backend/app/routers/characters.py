import aiosqlite
from fastapi import APIRouter, Depends, Form, UploadFile

from ..db import get_db
from ..errors import AppError, NotFoundError
from ..models.schemas import CardAssistRequest, CharacterIn, CharacterUpdate
from ..repositories import characters as repo
from ..repositories import conversations as convo_repo
from ..repositories import lore as lore_repo
from ..services import card_assistant, media, turns

router = APIRouter(prefix="/api/characters", tags=["characters"])


@router.get("")
async def list_characters(db: aiosqlite.Connection = Depends(get_db)):
    """All of them: the interface searches the list it has."""
    return await repo.list_all(db)


@router.post("", status_code=201)
async def create_character(payload: CharacterIn, db: aiosqlite.Connection = Depends(get_db)):
    return await repo.create(db, payload.model_dump())


@router.post("/assist", status_code=202)
async def assist_card(payload: CardAssistRequest, db: aiosqlite.Connection = Depends(get_db)):
    """Begin drafting a full card from a free-form brief (nothing is saved); answers at once."""
    return {"id": await card_assistant.start(db, payload)}


# Declared before the routes of a character, so that no id of a card ever stands for one of these.
@router.get("/assist/{job_id}")
async def assist_state(job_id: str):
    return card_assistant.state(job_id)


@router.delete("/assist/{job_id}")
async def stop_assist(job_id: str):
    return await card_assistant.stop(job_id)


@router.get("/{char_id}")
async def get_character(char_id: str, db: aiosqlite.Connection = Depends(get_db)):
    character = await repo.get(db, char_id)
    if not character:
        raise NotFoundError("Character not found.", "character")
    return {**character, "lore_entries": await lore_repo.list_for_character(db, char_id)}


@router.get("/{char_id}/card")
async def get_card(char_id: str, db: aiosqlite.Connection = Depends(get_db)):
    """The card file the character was read from, apart from it for its weight; null when made here."""
    if not await repo.get(db, char_id):
        raise NotFoundError("Character not found.", "character")
    return await repo.get_card(db, char_id)


@router.put("/{char_id}")
async def update_character(char_id: str, payload: CharacterUpdate,
                           db: aiosqlite.Connection = Depends(get_db)):
    updated = await repo.update(db, char_id, payload.model_dump(exclude_unset=True))
    if not updated:
        raise NotFoundError("Character not found.", "character")
    return updated


@router.delete("/{char_id}", status_code=204)
async def delete_character(char_id: str, db: aiosqlite.Connection = Depends(get_db)):
    for convo in await convo_repo.list_all(db, character_id=char_id):  # they go with it
        await turns.stop(convo["id"])
    if not await repo.delete(db, char_id):
        raise NotFoundError("Character not found.", "character")


@router.post("/{char_id}/avatar")
async def upload_avatar(char_id: str, file: UploadFile,
                        db: aiosqlite.Connection = Depends(get_db)):
    data, extension = await media.read_image_upload(file)
    if not await repo.get(db, char_id):
        raise NotFoundError("Character not found.", "character")
    portrait = await repo.set_portrait(db, char_id, media.save(data, extension))
    if not portrait:
        raise NotFoundError("Character not found.", "character")
    return portrait


@router.post("/{char_id}/avatar/sizes")
async def keep_portrait_sizes(char_id: str, grid: UploadFile, backdrop: UploadFile,
                              portrait: str = Form(pattern=r"^[0-9a-f]{32}\.(png|jpg|webp)$"),
                              db: aiosqlite.Connection = Depends(get_db)):
    """The smaller copies of a portrait, made by a browser: one for the grid, one for the backdrop.
    `portrait` names the picture they were made from, so that copies of one replaced meanwhile
    are refused rather than shown under the new one."""
    if not await repo.get(db, char_id):
        raise NotFoundError("Character not found.", "character")
    copies = [await media.read_image_upload(file) for file in (grid, backdrop)]
    for data, extension in copies:
        # The page makes no PNG copies, and a card's PNG can carry megabytes of text.
        if extension == ".png" or not media.matches_type(data, extension):
            raise AppError("Unsupported image format (JPEG or WebP).", kind="unsupported_image")
    names: list[str] = []
    outcome = None
    try:
        for data, extension in copies:
            names.append(media.save(data, extension))
        outcome = await repo.keep_sizes(db, char_id, portrait, *names)
    finally:
        # Unless kept, nothing points to what this request wrote, a full disk or a locked
        # database included. Only those names: the copies already kept stay.
        if outcome != "kept":
            for name in names:
                media.discard(name)
    if outcome == "portrait_changed":
        raise AppError("The portrait changed while its copies were made.", 409,
                       kind="portrait_changed")
    if outcome == "not_found":
        raise NotFoundError("Character not found.", "character")
    return await get_character(char_id, db)
