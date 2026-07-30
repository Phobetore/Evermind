import aiosqlite
from fastapi import APIRouter, Depends

from ..db import get_db
from ..models.schemas import SettingsIn
from ..repositories import settings as repo

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
async def get_settings(db: aiosqlite.Connection = Depends(get_db)):
    return await repo.get_all(db)


@router.put("")
async def put_settings(payload: SettingsIn, db: aiosqlite.Connection = Depends(get_db)):
    return await repo.put(db, payload.model_dump(exclude_unset=True))
