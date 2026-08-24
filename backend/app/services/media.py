"""Taking an uploaded image and keeping it.

Three routers need this — a character's portrait, a persona's, and a
conversation's backdrop — and until the third came along personas was reaching
into the characters router for its private helpers to get it.
"""

import aiosqlite
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


# Every column that can point at a file in the media folder. Miss one and the
# sweep below deletes something still in use, so this list is the whole safety
# of it.
_REFERENCES = (
    ("characters", "avatar_path"),
    ("personas", "avatar_path"),
    ("conversations", "wallpaper_path"),
)


async def forget(db: aiosqlite.Connection, filename: str) -> bool:
    """Delete a stored file, unless something still points at it.

    Replacing a portrait or a backdrop used to leave the old file behind for
    good: nothing in the app could reach it again and nothing ever removed it,
    so the folder grew with every change. It cannot simply be deleted either —
    branching a conversation gives two of them the same backdrop, and one of
    them clearing it must not blank the other. Hence the count first.
    """
    if not filename:
        return False
    for table, column in _REFERENCES:
        row = await (await db.execute(
            f"SELECT 1 FROM {table} WHERE {column} = ? LIMIT 1", (filename,))).fetchone()
        if row:
            return False
    path = (media_dir() / filename).resolve()
    # Only ever inside the media folder, and only a name the database gave us.
    if path.parent != media_dir().resolve() or not path.is_file():
        return False
    path.unlink()
    return True
