"""CRUD endpoints for characters."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.repositories.character_repository import CharacterRepository
from app.models.character import (
    CharacterCreate,
    CharacterImport,
    CharacterResponse,
    CharacterUpdate,
)

router = APIRouter(prefix="/characters", tags=["characters"])


def _get_repo() -> CharacterRepository:
    return CharacterRepository()


@router.get("", response_model=list[CharacterResponse])
async def list_characters(
    search: str | None = None,
    repo: CharacterRepository = Depends(_get_repo),
) -> list[CharacterResponse]:
    return await repo.list(search=search)


@router.post("", response_model=CharacterResponse, status_code=201)
async def create_character(
    data: CharacterCreate,
    repo: CharacterRepository = Depends(_get_repo),
) -> CharacterResponse:
    return await repo.create(data)


@router.get("/{character_id}", response_model=CharacterResponse)
async def get_character(
    character_id: str,
    repo: CharacterRepository = Depends(_get_repo),
) -> CharacterResponse:
    character = await repo.get(character_id)
    if character is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return character


@router.put("/{character_id}", response_model=CharacterResponse)
async def update_character(
    character_id: str,
    data: CharacterUpdate,
    repo: CharacterRepository = Depends(_get_repo),
) -> CharacterResponse:
    character = await repo.update(character_id, data)
    if character is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return character


@router.delete("/{character_id}", status_code=204)
async def delete_character(
    character_id: str,
    repo: CharacterRepository = Depends(_get_repo),
) -> None:
    deleted = await repo.delete(character_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Character not found")


@router.get("/{character_id}/export")
async def export_character(
    character_id: str,
    repo: CharacterRepository = Depends(_get_repo),
) -> dict:
    """Export a character as a portable JSON object."""
    character = await repo.get(character_id)
    if character is None:
        raise HTTPException(status_code=404, detail="Character not found")
    data = character.model_dump()
    # Remove server-side fields that shouldn't be in an export
    data.pop("id", None)
    data.pop("created_at", None)
    data.pop("updated_at", None)
    return {"version": "1", "character": data}


@router.post("/import", response_model=CharacterResponse, status_code=201)
async def import_character(
    payload: CharacterImport,
    repo: CharacterRepository = Depends(_get_repo),
) -> CharacterResponse:
    """Import a character from a portable JSON export."""
    return await repo.create(payload.character)
