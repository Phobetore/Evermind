import json
import re
import unicodedata
from urllib.parse import quote

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
from ..services import card_assistant, media

router = APIRouter(prefix="/api/characters", tags=["characters"])


_JOINERS = "\u200c\u200d"


def _file_stem(name: str, *, ascii_only: bool) -> str:
    """The card's name with what a file name cannot carry taken out.

    Among ASCII characters only letters, digits, spaces, hyphens and underscores
    stay. Other scripts and symbols stay too, unless ``ascii_only`` is set, but
    not control or separator characters, which have no place in a file name.
    The zero-width joiners are the exception: some scripts and emoji sequences
    need them to be spelled right. They stay between other characters and are
    trimmed, with the spaces, from the start and the end of the name, where they
    have nothing to join.

    With ``ascii_only``, a letter with an accent keeps its letter: "é" is an "e"
    and a combining accent once decomposed, and the accent is what is dropped.
    Runs of spaces, which the characters taken out leave behind, become one. A
    name with nothing left but hyphens, underscores, spaces and joiners, which
    is to say no name, is called "card".
    """
    if ascii_only:
        name = "".join(
            c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c)
        )

    def keep(c: str) -> bool:
        if c.isascii():
            return c.isalnum() or c in " -_"
        return not ascii_only and (c.isprintable() or c in _JOINERS)

    stem = re.sub(" {2,}", " ", "".join(c for c in name if keep(c))).strip(" " + _JOINERS)
    return stem if stem.strip("-_ " + _JOINERS) else "card"


def _attachment(name: str, extension: str) -> str:
    """A Content-Disposition value for a download named after the card.

    HTTP headers are latin-1, so a name in Cyrillic, CJK or emoji cannot go in
    ``filename`` as it is. That parameter holds an ASCII fallback and
    ``filename*`` (RFC 5987) holds the real name, percent-encoded UTF-8, which
    is the one browsers prefer.
    """
    fallback = _file_stem(name, ascii_only=True) + extension
    real = quote(_file_stem(name, ascii_only=False) + extension, safe="")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{real}"


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
    data = await media.read_upload(file)
    avatar_path = None
    if is_png(data):
        card = read_card_from_png(data)
        if not card:
            raise AppError("This PNG does not contain a character card (no \"chara\" chunk).",
                           kind="png_without_card")
        avatar_path = media.save(data, ".png")
    else:
        try:
            card = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise AppError("Unrecognized file: provide a JSON card or a card PNG.",
                           kind="unrecognized_card_file")
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
        raise NotFoundError("Character not found.", "character")
    return character


@router.put("/{char_id}")
async def update_character(char_id: str, payload: CharacterUpdate,
                           db: aiosqlite.Connection = Depends(get_db)):
    updated = await repo.update(db, char_id, payload.model_dump(exclude_unset=True))
    if not updated:
        raise NotFoundError("Character not found.", "character")
    return updated


@router.delete("/{char_id}", status_code=204)
async def delete_character(char_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await repo.delete(db, char_id):
        raise NotFoundError("Character not found.", "character")


@router.get("/{char_id}/export")
async def export_character(char_id: str, format: str = "json",
                           db: aiosqlite.Connection = Depends(get_db)):
    character = await repo.get_raw(db, char_id)
    if not character:
        raise NotFoundError("Character not found.", "character")
    card = character_to_card(character, lore_entries=await lore_repo.list_for_character(db, char_id))
    name = character["name"]

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
            headers={"Content-Disposition": _attachment(name, ".png")},
        )

    return JSONResponse(content=card, headers={"Content-Disposition": _attachment(name, ".json")})


@router.post("/{char_id}/avatar")
async def upload_avatar(char_id: str, file: UploadFile,
                        db: aiosqlite.Connection = Depends(get_db)):
    data, extension = await media.read_image_upload(file)
    filename = media.save(data, extension)
    updated = await repo.update(db, char_id, {"avatar_path": filename})
    if not updated:
        raise NotFoundError("Character not found.", "character")
    return updated
