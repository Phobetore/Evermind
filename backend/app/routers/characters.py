import json

import aiosqlite
from fastapi import APIRouter, Depends, UploadFile
from fastapi.responses import JSONResponse, Response

from ..cards.codec import card_to_character, card_to_lore_entries, character_to_card
from ..cards.png import is_png, make_placeholder_png, read_card_from_png, write_card_to_png
from ..config import media_dir
from ..db import get_db
from ..errors import AppError, NotFoundError
from ..models.schemas import CardAssistRequest, CharacterIn, CharacterUpdate
from ..repositories import characters as repo
from ..repositories import lore as lore_repo
from ..repositories.base import new_id
from ..services import card_assistant

router = APIRouter(prefix="/api/characters", tags=["characters"])

_ALLOWED_AVATAR_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
_MAX_UPLOAD_BYTES = 15 * 1024 * 1024


async def _read_upload(file: UploadFile) -> bytes:
    data = await file.read()
    if len(data) > _MAX_UPLOAD_BYTES:
        raise AppError("File too large (15 MB max).", 413)
    return data


def _save_media(data: bytes, extension: str) -> str:
    filename = f"{new_id()}{extension}"
    (media_dir() / filename).write_bytes(data)
    return filename


@router.get("")
async def list_characters(kind: str | None = None, q: str | None = None,
                          tag: str | None = None, favorites: bool = False,
                          db: aiosqlite.Connection = Depends(get_db)):
    return await repo.list_all(db, kind=kind, q=q, tag=tag, favorites=favorites)


@router.post("", status_code=201)
async def create_character(payload: CharacterIn, db: aiosqlite.Connection = Depends(get_db)):
    return await repo.create(db, payload.model_dump())


@router.post("/import", status_code=201)
async def import_character(file: UploadFile, db: aiosqlite.Connection = Depends(get_db)):
    data = await _read_upload(file)
    avatar_path = None
    if is_png(data):
        card = read_card_from_png(data)
        if not card:
            raise AppError("This PNG does not contain a character card (no \"chara\" chunk).")
        avatar_path = _save_media(data, ".png")
    else:
        try:
            card = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise AppError("Unrecognized file: provide a JSON card or a card PNG.")
    fields = card_to_character(card)
    fields["avatar_path"] = avatar_path
    created = await repo.create(db, fields)
    for entry in card_to_lore_entries(card):
        await lore_repo.add(db, created["id"], **entry)
    return created


@router.post("/assist")
async def assist_card(payload: CardAssistRequest, db: aiosqlite.Connection = Depends(get_db)):
    """Generate a full card draft from a free-form brief (nothing is saved)."""
    return await card_assistant.generate_card(
        db, prompt=payload.prompt, kind=payload.kind,
        connection_id=payload.connection_id, existing=payload.existing,
    )


@router.get("/{char_id}")
async def get_character(char_id: str, db: aiosqlite.Connection = Depends(get_db)):
    character = await repo.get(db, char_id)
    if not character:
        raise NotFoundError("Character not found.")
    return character


@router.put("/{char_id}")
async def update_character(char_id: str, payload: CharacterUpdate,
                           db: aiosqlite.Connection = Depends(get_db)):
    updated = await repo.update(db, char_id, payload.model_dump(exclude_unset=True))
    if not updated:
        raise NotFoundError("Character not found.")
    return updated


@router.delete("/{char_id}", status_code=204)
async def delete_character(char_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await repo.delete(db, char_id):
        raise NotFoundError("Character not found.")


@router.get("/{char_id}/export")
async def export_character(char_id: str, format: str = "json",
                           db: aiosqlite.Connection = Depends(get_db)):
    character = await repo.get_raw(db, char_id)
    if not character:
        raise NotFoundError("Character not found.")
    card = character_to_card(character, lore_entries=await lore_repo.list_for_character(db, char_id))
    safe_name = "".join(c for c in character["name"] if c.isalnum() or c in " -_").strip() or "card"

    if format == "png":
        base = None
        if character.get("avatar_path"):
            path = media_dir() / character["avatar_path"]
            if path.exists() and path.suffix == ".png":
                base = path.read_bytes()
        if base is None or not is_png(base):
            base = make_placeholder_png()
        return Response(
            content=write_card_to_png(base, card),
            media_type="image/png",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.png"'},
        )

    return JSONResponse(
        content=card,
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.json"'},
    )


@router.post("/{char_id}/avatar")
async def upload_avatar(char_id: str, file: UploadFile,
                        db: aiosqlite.Connection = Depends(get_db)):
    extension = _ALLOWED_AVATAR_TYPES.get(file.content_type or "")
    if not extension:
        raise AppError("Unsupported image format (PNG, JPEG or WebP).")
    data = await _read_upload(file)
    filename = _save_media(data, extension)
    updated = await repo.update(db, char_id, {"avatar_path": filename})
    if not updated:
        raise NotFoundError("Character not found.")
    return updated
