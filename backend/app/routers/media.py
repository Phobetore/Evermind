import re

from fastapi import APIRouter
from fastapi.responses import FileResponse

from ..config import media_dir
from ..errors import NotFoundError

router = APIRouter(prefix="/api/media", tags=["media"])

_MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}
# The names services/media.py gives. Checked first: a path call opens \\host\share\x on Windows.
_STORED = re.compile(r"[0-9a-f]{32}\.(png|jpg|webp)")
# Private: the images are behind the access password. Immutable: every upload gets a new name.
_CACHE = {"Cache-Control": "private, max-age=31536000, immutable"}


@router.get("/{filename}")
async def get_media(filename: str):
    if not _STORED.fullmatch(filename):
        raise NotFoundError("File not found.", "file")
    path = (media_dir() / filename).resolve()
    if path.parent != media_dir().resolve() or not path.is_file():
        raise NotFoundError("File not found.", "file")
    media_type = _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type, headers=_CACHE)
