"""Endpoints for character memories and world state."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.repositories.memory_repository import MemoryRepository
from app.core.repositories.world_state_repository import WorldStateRepository
from app.models.memory import (
    MemoryCreate,
    MemoryResponse,
    WorldStateResponse,
    WorldStateUpdate,
)

router = APIRouter(prefix="/characters/{character_id}", tags=["memory"])


def _get_mem_repo() -> MemoryRepository:
    return MemoryRepository()


def _get_ws_repo() -> WorldStateRepository:
    return WorldStateRepository()


# --- Memories ---


@router.get("/memories", response_model=list[MemoryResponse])
async def list_memories(
    character_id: str,
    type: str | None = None,
    include_deleted: bool = False,
    repo: MemoryRepository = Depends(_get_mem_repo),
) -> list[MemoryResponse]:
    return await repo.list_by_character(
        character_id, type_filter=type, include_deleted=include_deleted
    )


@router.post("/memories", response_model=MemoryResponse, status_code=201)
async def create_memory(
    character_id: str,
    data: MemoryCreate,
    repo: MemoryRepository = Depends(_get_mem_repo),
) -> MemoryResponse:
    if data.character_id != character_id:
        raise HTTPException(status_code=400, detail="character_id mismatch")
    return await repo.create(data)


@router.post("/memories/forget", status_code=200)
async def forget_memory(
    memory_id: str,
    repo: MemoryRepository = Depends(_get_mem_repo),
) -> dict:
    ok = await repo.soft_delete(memory_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"status": "forgotten"}


@router.post("/memories/{memory_id}/pin", status_code=200)
async def pin_memory(
    memory_id: str,
    repo: MemoryRepository = Depends(_get_mem_repo),
) -> dict:
    ok = await repo.pin(memory_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"status": "pinned"}


@router.post("/memories/{memory_id}/unpin", status_code=200)
async def unpin_memory(
    memory_id: str,
    repo: MemoryRepository = Depends(_get_mem_repo),
) -> dict:
    ok = await repo.unpin(memory_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"status": "unpinned"}


# --- World State ---


@router.get("/world_state", response_model=WorldStateResponse | None)
async def get_world_state(
    character_id: str,
    repo: WorldStateRepository = Depends(_get_ws_repo),
) -> WorldStateResponse | None:
    return await repo.get(character_id)


@router.put("/world_state", response_model=WorldStateResponse)
async def update_world_state(
    character_id: str,
    data: WorldStateUpdate,
    repo: WorldStateRepository = Depends(_get_ws_repo),
) -> WorldStateResponse:
    return await repo.upsert(character_id, data.state)
