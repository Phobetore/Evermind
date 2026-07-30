from fastapi import APIRouter
from fastapi.responses import FileResponse

from ..config import media_dir
from ..errors import NotFoundError

router = APIRouter(prefix="/api/media", tags=["media"])

_MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}


@router.get("/{filename}")
async def get_media(filename: str):
    path = (media_dir() / filename).resolve()
    if path.parent != media_dir().resolve() or not path.is_file():
        raise NotFoundError("File not found.")
    media_type = _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type)
