"""Starter library: cards shipped with the repo, installable in one click."""

import json
import re
import shutil

import aiosqlite
from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse

from ..cards.codec import card_to_character, card_to_lore_entries
from ..config import library_dir, media_dir
from ..db import get_db
from ..errors import AppError, NotFoundError
from ..repositories import characters as characters_repo
from ..repositories import lore as lore_repo
from ..repositories.base import new_id

router = APIRouter(prefix="/api/library", tags=["library"])

_SAFE_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*\.json$")
_IMAGE_EXTENSIONS = (".jpg", ".png", ".webp")
_IMAGE_TYPES = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


def _read_card(filename: str) -> dict | None:
    if not _SAFE_NAME.match(filename):
        return None
    path = library_dir() / filename
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def _image_path(filename: str):
    """Companion illustration: same basename as the card, image extension."""
    if not _SAFE_NAME.match(filename):
        return None
    stem = library_dir() / filename[: -len(".json")]
    for extension in _IMAGE_EXTENSIONS:
        candidate = stem.with_suffix(extension)
        if candidate.is_file():
            return candidate
    return None


@router.get("")
async def list_library(db: aiosqlite.Connection = Depends(get_db)):
    directory = library_dir()
    if not directory.is_dir():
        return []
    existing_names = {c["name"] for c in await characters_repo.list_all(db)}
    items = []
    for path in sorted(directory.glob("*.json")):
        card = _read_card(path.name)
        if not card:
            continue
        fields = card_to_character(card)
        items.append({
            "filename": path.name,
            "name": fields["name"],
            "kind": fields["kind"],
            "tagline": fields["tagline"],
            "tags": fields["tags"],
            "creator_notes": fields["creator_notes"],
            "has_lorebook": bool(card_to_lore_entries(card)),
            "has_avatar": _image_path(path.name) is not None,
            "installed": fields["name"] in existing_names,
        })
    return items


@router.get("/{filename}/avatar")
async def library_avatar(filename: str):
    path = _image_path(filename)
    if path is None:
        raise NotFoundError("No illustration for this card.")
    return FileResponse(path, media_type=_IMAGE_TYPES.get(path.suffix, "image/jpeg"))


@router.post("/{filename}/install", status_code=201)
async def install_card(filename: str, db: aiosqlite.Connection = Depends(get_db)):
    card = _read_card(filename)
    if card is None:
        raise NotFoundError("Card not found in the library.")
    fields = card_to_character(card)
    existing = {c["name"] for c in await characters_repo.list_all(db)}
    if fields["name"] in existing:
        raise AppError("This card is already installed.")
    image = _image_path(filename)
    if image is not None:
        target = f"{new_id()}{image.suffix}"
        shutil.copyfile(image, media_dir() / target)
        fields["avatar_path"] = target
    created = await characters_repo.create(db, fields)
    for entry in card_to_lore_entries(card):
        await lore_repo.add(db, created["id"], **entry)
    return created
