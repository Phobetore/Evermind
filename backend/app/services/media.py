"""Taking an uploaded image and keeping it: a portrait, a persona's, or a backdrop."""

from fastapi import UploadFile

from ..config import media_dir
from ..errors import AppError
from ..repositories.base import new_id

ALLOWED_IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
MAX_UPLOAD_BYTES = 15 * 1024 * 1024


async def read_image_upload(file: UploadFile) -> tuple[bytes, str]:
    """The bytes, plus the extension the declared type maps to."""
    extension = ALLOWED_IMAGE_TYPES.get(file.content_type or "")
    if not extension:
        raise AppError("Unsupported image format (PNG, JPEG or WebP).", kind="unsupported_image")
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise AppError("File too large (15 MB max).", 413, kind="file_too_large")
    return data, extension


def save(data: bytes, extension: str) -> str:
    filename = f"{new_id()}{extension}"
    (media_dir() / filename).write_bytes(data)
    return filename
