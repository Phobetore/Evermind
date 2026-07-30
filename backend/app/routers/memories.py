import aiosqlite
from fastapi import APIRouter, Depends

from ..db import get_db
from ..errors import AppError, NotFoundError
from ..models.schemas import MemoryIn, MemoryPatch
from ..repositories import conversations as convo_repo
from ..repositories import memories as repo
from ..services import memory_service

router = APIRouter(prefix="/api", tags=["memories"])


@router.get("/conversations/{convo_id}/memories")
async def list_memories(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await convo_repo.get(db, convo_id, with_messages=False):
        raise NotFoundError("Conversation not found.")
    return await repo.list_for_conversation(db, convo_id)


@router.post("/conversations/{convo_id}/memories", status_code=201)
async def add_memory(convo_id: str, payload: MemoryIn,
                     db: aiosqlite.Connection = Depends(get_db)):
    if not await convo_repo.get(db, convo_id, with_messages=False):
        raise NotFoundError("Conversation not found.")
    saved = await repo.add(db, convo_id, content=payload.content, kind=payload.kind,
                           is_pinned=payload.is_pinned, source="user")
    if not saved:
        raise AppError("This fact already exists.")
    return saved


@router.post("/conversations/{convo_id}/memories/extract")
async def extract_now(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await convo_repo.get(db, convo_id, with_messages=False):
        raise NotFoundError("Conversation not found.")
    try:
        result = await memory_service.run_maintenance(db, convo_id)
    except ValueError as exc:
        raise AppError(str(exc), 502)
    return {
        "facts_added": result.get("facts_added", []),
        "summary": result.get("summary"),
        "memories": await repo.list_for_conversation(db, convo_id),
    }


@router.post("/conversations/{convo_id}/memories/consolidate")
async def consolidate_memories(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await convo_repo.get(db, convo_id, with_messages=False):
        raise NotFoundError("Conversation not found.")
    try:
        return await memory_service.consolidate(db, convo_id)
    except ValueError as exc:
        raise AppError(str(exc), 502)


@router.patch("/memories/{memory_id}")
async def patch_memory(memory_id: str, payload: MemoryPatch,
                       db: aiosqlite.Connection = Depends(get_db)):
    updated = await repo.update(db, memory_id, content=payload.content,
                                is_pinned=payload.is_pinned)
    if not updated:
        raise NotFoundError("Fact not found.")
    return updated


@router.delete("/memories/{memory_id}", status_code=204)
async def delete_memory(memory_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await repo.delete(db, memory_id):
        raise NotFoundError("Fact not found.")
