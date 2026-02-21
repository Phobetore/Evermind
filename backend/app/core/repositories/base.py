"""Base repository providing a shared database connection helper."""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.core.database import get_db

if TYPE_CHECKING:
    import aiosqlite


class BaseRepository:
    """Thin base that holds (or creates) a database connection."""

    def __init__(self, db: aiosqlite.Connection | None = None) -> None:
        self._db = db

    async def _get_db(self) -> aiosqlite.Connection:
        if self._db is None:
            self._db = await get_db()
        return self._db

    async def close(self) -> None:
        if self._db is not None:
            await self._db.close()
            self._db = None
