"""Taking an uploaded image and keeping it.

Three routers need this — a character's portrait, a persona's, and a
conversation's backdrop — and until the third came along personas was reaching
into the characters router for its private helpers to get it.
"""

from fastapi import UploadFile

from ..config import media_dir
from ..errors import AppError
from ..repositories.base import new_id

ALLOWED_IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
MAX_UPLOAD_BYTES = 15 * 1024 * 1024


async def read_upload(file: UploadFile) -> bytes:
    """Any upload, image or not: a card can arrive as JSON."""
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise AppError("File too large (15 MB max).", 413)
    return data


async def read_image_upload(file: UploadFile) -> tuple[bytes, str]:
    """The bytes, plus the extension the declared type maps to."""
    extension = ALLOWED_IMAGE_TYPES.get(file.content_type or "")
    if not extension:
        raise AppError("Unsupported image format (PNG, JPEG or WebP).")
    return await read_upload(file), extension


def save(data: bytes, extension: str) -> str:
    filename = f"{new_id()}{extension}"
    (media_dir() / filename).write_bytes(data)
    return filename
