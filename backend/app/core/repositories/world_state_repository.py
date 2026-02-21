"""World state repository — per-character JSON state persistence."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.core.repositories.base import BaseRepository
from app.models.memory import WorldStateResponse

if TYPE_CHECKING:
    import aiosqlite


class WorldStateRepository(BaseRepository):
    async def get(self, character_id: str) -> WorldStateResponse | None:
        db = await self._get_db()
        cursor = await db.execute(
            "SELECT * FROM world_state WHERE character_id = ?", (character_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return _row_to_response(row)

    async def upsert(self, character_id: str, state: dict) -> WorldStateResponse:
        db = await self._get_db()
        now = datetime.now(UTC).isoformat()
        state_json = json.dumps(state)
        await db.execute(
            """
            INSERT INTO world_state (character_id, state, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(character_id) DO UPDATE SET state = ?, updated_at = ?
            """,
            (character_id, state_json, now, state_json, now),
        )
        await db.commit()
        return await self.get(character_id)  # type: ignore[return-value]

    async def update_field(
        self, character_id: str, field: str, value: object
    ) -> WorldStateResponse | None:
        existing = await self.get(character_id)
        if existing is None:
            return None
        state = dict(existing.state)
        state[field] = value
        return await self.upsert(character_id, state)


def _row_to_response(row: aiosqlite.Row) -> WorldStateResponse:
    return WorldStateResponse(
        character_id=row["character_id"],
        state=json.loads(row["state"]),
        updated_at=row["updated_at"],
    )
