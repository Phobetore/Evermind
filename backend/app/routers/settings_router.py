import aiosqlite
from fastapi import APIRouter, Depends

from ..db import get_db
from ..errors import PAGE_OUTDATED, RELOAD, AppError
from ..models.schemas import SettingsIn
from ..repositories import settings as repo

router = APIRouter(prefix="/api/settings", tags=["settings"])

# The way of playing before ways existed: a page opened before the update still sends them, and
# writing them would change nothing any more. It is told to reload instead.
_OUTDATED = ("reply_length", "history_limit", "passage_budget")


@router.get("")
async def get_settings(db: aiosqlite.Connection = Depends(get_db)):
    return await repo.get_all(db)


@router.put("")
async def put_settings(payload: SettingsIn, db: aiosqlite.Connection = Depends(get_db)):
    values = payload.model_dump(exclude_unset=True)
    if any(key in values for key in _OUTDATED):
        raise AppError(RELOAD, 410, kind=PAGE_OUTDATED)
    return await repo.put(db, values)
