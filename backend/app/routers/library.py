"""Starter library: cards shipped with the repo, which the interface installs."""

import json
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

from ..config import library_dir
from ..errors import NotFoundError

router = APIRouter(prefix="/api/library", tags=["library"])


def _cards() -> dict[str, Path]:
    """The cards by file name: a name from a URL is looked up here, and never made into a path."""
    directory = library_dir()
    return {path.name: path for path in sorted(directory.glob("*.json"))} if directory.is_dir() else {}


@router.get("")
async def list_library():
    items = []
    for filename, path in _cards().items():
        try:
            card = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        items.append({"filename": filename, "card": card,
                      "has_avatar": path.with_suffix(".jpg").is_file()})
    return items


@router.get("/{filename}/avatar")
async def library_avatar(filename: str):
    path = _cards().get(filename)
    if path is None or not path.with_suffix(".jpg").is_file():
        raise NotFoundError("No illustration for this card.", "illustration")
    return FileResponse(path.with_suffix(".jpg"), media_type="image/jpeg")
