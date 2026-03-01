"""CRUD endpoints for user personas (user profiles for RP interactions)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.core.database import _PROJECT_ROOT
from app.core.repositories.user_persona_repository import UserPersonaRepository
from app.models.user_persona import UserPersonaCreate, UserPersonaResponse, UserPersonaUpdate

router = APIRouter(prefix="/user_personas", tags=["user_personas"])

# Avatar images are stored under data/avatars/
_AVATARS_DIR = _PROJECT_ROOT / "data" / "avatars"

_ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
_MAX_AVATAR_BYTES = 5 * 1024 * 1024  # 5 MB


def _get_repo() -> UserPersonaRepository:
    return UserPersonaRepository()


@router.get("", response_model=list[UserPersonaResponse])
async def list_personas(
    repo: UserPersonaRepository = Depends(_get_repo),
) -> list[UserPersonaResponse]:
    return await repo.list_all()


@router.post("", response_model=UserPersonaResponse, status_code=201)
async def create_persona(
    data: UserPersonaCreate,
    repo: UserPersonaRepository = Depends(_get_repo),
) -> UserPersonaResponse:
    return await repo.create(data)


@router.get("/{persona_id}", response_model=UserPersonaResponse)
async def get_persona(
    persona_id: str,
    repo: UserPersonaRepository = Depends(_get_repo),
) -> UserPersonaResponse:
    persona = await repo.get(persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="User persona not found")
    return persona


@router.patch("/{persona_id}", response_model=UserPersonaResponse)
async def update_persona(
    persona_id: str,
    data: UserPersonaUpdate,
    repo: UserPersonaRepository = Depends(_get_repo),
) -> UserPersonaResponse:
    persona = await repo.update(persona_id, data)
    if persona is None:
        raise HTTPException(status_code=404, detail="User persona not found")
    return persona


@router.delete("/{persona_id}", status_code=204)
async def delete_persona(
    persona_id: str,
    repo: UserPersonaRepository = Depends(_get_repo),
) -> None:
    # Clean up avatar file if it exists
    persona = await repo.get(persona_id)
    if persona and persona.avatar_path:
        avatar_file = _AVATARS_DIR / persona.avatar_path
        if avatar_file.is_file():
            avatar_file.unlink(missing_ok=True)

    deleted = await repo.delete(persona_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="User persona not found")


@router.post("/{persona_id}/avatar", response_model=UserPersonaResponse)
async def upload_avatar(
    persona_id: str,
    file: UploadFile,
    repo: UserPersonaRepository = Depends(_get_repo),
) -> UserPersonaResponse:
    """Upload or replace the avatar image for a user persona."""
    persona = await repo.get(persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="User persona not found")

    if file.content_type not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported image type: {file.content_type}. Allowed: JPEG, PNG, WebP, GIF",
        )

    # Read and validate file size
    content = await file.read()
    if len(content) > _MAX_AVATAR_BYTES:
        raise HTTPException(status_code=400, detail="Avatar image must be under 5 MB")

    # Determine extension from content type
    ext_map = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
    ext = ext_map.get(file.content_type, ".png")

    # Remove old avatar if it exists
    if persona.avatar_path:
        old_file = _AVATARS_DIR / persona.avatar_path
        if old_file.is_file():
            old_file.unlink(missing_ok=True)

    # Save new avatar
    _AVATARS_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{persona_id}_{uuid.uuid4().hex[:8]}{ext}"
    dest = _AVATARS_DIR / filename
    dest.write_bytes(content)

    result = await repo.set_avatar(persona_id, filename)
    if result is None:
        raise HTTPException(status_code=404, detail="User persona not found")
    return result


@router.delete("/{persona_id}/avatar", response_model=UserPersonaResponse)
async def delete_avatar(
    persona_id: str,
    repo: UserPersonaRepository = Depends(_get_repo),
) -> UserPersonaResponse:
    """Remove the avatar image for a user persona."""
    persona = await repo.get(persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="User persona not found")

    if persona.avatar_path:
        avatar_file = _AVATARS_DIR / persona.avatar_path
        if avatar_file.is_file():
            avatar_file.unlink(missing_ok=True)

    result = await repo.set_avatar(persona_id, "")
    if result is None:
        raise HTTPException(status_code=404, detail="User persona not found")
    return result


@router.get("/{persona_id}/avatar/file")
async def get_avatar_file(
    persona_id: str,
    repo: UserPersonaRepository = Depends(_get_repo),
) -> FileResponse:
    """Serve the avatar image file for a user persona."""
    persona = await repo.get(persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="User persona not found")
    if not persona.avatar_path:
        raise HTTPException(status_code=404, detail="No avatar set for this persona")

    avatar_file = _AVATARS_DIR / persona.avatar_path
    if not avatar_file.is_file():
        raise HTTPException(status_code=404, detail="Avatar file not found")

    return FileResponse(str(avatar_file))
