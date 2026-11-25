import aiosqlite
from fastapi import APIRouter, Depends

from ..db import get_db
from ..models.schemas import WayCopyIn, WayDefaultIn, WayIn
from ..repositories import ways as repo

router = APIRouter(prefix="/api/ways", tags=["ways"])


@router.get("")
async def list_ways(db: aiosqlite.Connection = Depends(get_db)):
    return await repo.listing(db)


# Before PUT /{way_id}: routes are tried in order, and "default" would be read as a way's id.
@router.put("/default")
async def set_default(payload: WayDefaultIn, db: aiosqlite.Connection = Depends(get_db)):
    return await repo.set_default(db, payload.id)


@router.put("/{way_id}")
async def update_way(way_id: str, payload: WayIn, db: aiosqlite.Connection = Depends(get_db)):
    return await repo.update(db, way_id, payload.model_dump(exclude_unset=True))


@router.post("", status_code=201)
async def copy_way(payload: WayCopyIn, db: aiosqlite.Connection = Depends(get_db)):
    return await repo.copy(db, payload.from_id, payload.name)


@router.delete("/{way_id}")
async def remove_way(way_id: str, db: aiosqlite.Connection = Depends(get_db)):
    return await repo.remove(db, way_id)


@router.post("/{way_id}/reset")
async def reset_way(way_id: str, db: aiosqlite.Connection = Depends(get_db)):
    return await repo.reset(db, way_id)
