"""Taking an uploaded image and keeping it: a portrait, a persona's, or a backdrop."""

import re

from fastapi import UploadFile

from ..config import media_dir
from ..errors import AppError
from ..repositories.base import new_id

ALLOWED_IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
# The names save() gives, as routers/media serves them.
_SAVED = re.compile(r"[0-9a-f]{32}\.(png|jpg|webp)")


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


def matches_type(data: bytes, extension: str) -> bool:
    """The bytes begin as that type does: the declared type alone is the sender's word."""
    if extension == ".png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if extension == ".jpg":
        return data.startswith(b"\xff\xd8\xff")
    if extension == ".webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return False


def discard(filename: str) -> None:
    """Deletes a file save() wrote, by the name it gave. Any other name does nothing: it could
    point anywhere, the database included."""
    if _SAVED.fullmatch(filename):
        (media_dir() / filename).unlink(missing_ok=True)
