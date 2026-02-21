"""Memory repository — CRUD operations against SQLite."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.core.repositories.base import BaseRepository
from app.models.memory import MemoryCreate, MemoryResponse, MemoryUpdate

if TYPE_CHECKING:
    import aiosqlite


class MemoryRepository(BaseRepository):
    async def create(self, data: MemoryCreate) -> MemoryResponse:
        db = await self._get_db()
        now = datetime.now(UTC).isoformat()
        memory_id = str(uuid.uuid4())
        await db.execute(
            """
            INSERT INTO memories
                (id, character_id, type, title, content, entities, tags,
                 importance, confidence, created_at, source_turn_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                memory_id,
                data.character_id,
                data.type,
                data.title,
                data.content,
                json.dumps(data.entities),
                json.dumps(data.tags),
                data.importance,
                data.confidence,
                now,
                data.source_turn_id,
            ),
        )
        await db.commit()
        return await self.get(memory_id)  # type: ignore[return-value]

    async def get(self, memory_id: str) -> MemoryResponse | None:
        db = await self._get_db()
        cursor = await db.execute("SELECT * FROM memories WHERE id = ?", (memory_id,))
        row = await cursor.fetchone()
        if row is None:
            return None
        return _row_to_response(row)

    async def list_by_character(
        self,
        character_id: str,
        type_filter: str | None = None,
        include_deleted: bool = False,
    ) -> list[MemoryResponse]:
        db = await self._get_db()
        conditions = ["character_id = ?"]
        params: list = [character_id]

        if not include_deleted:
            conditions.append("is_deleted = 0")

        if type_filter:
            conditions.append("type = ?")
            params.append(type_filter)

        where = " AND ".join(conditions)
        cursor = await db.execute(
            f"SELECT * FROM memories WHERE {where} ORDER BY importance DESC, created_at DESC",
            params,
        )
        rows = await cursor.fetchall()
        return [_row_to_response(r) for r in rows]

    async def update(self, memory_id: str, data: MemoryUpdate) -> MemoryResponse | None:
        existing = await self.get(memory_id)
        if existing is None:
            return None
        db = await self._get_db()
        updates = data.model_dump(exclude_unset=True)
        if not updates:
            return existing
        # Serialise JSON fields
        for field in ("entities", "tags"):
            if field in updates:
                updates[field] = json.dumps(updates[field])
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [memory_id]
        await db.execute(f"UPDATE memories SET {set_clause} WHERE id = ?", values)
        await db.commit()
        return await self.get(memory_id)

    async def soft_delete(self, memory_id: str) -> bool:
        db = await self._get_db()
        cursor = await db.execute(
            "UPDATE memories SET is_deleted = 1 WHERE id = ?", (memory_id,)
        )
        await db.commit()
        return cursor.rowcount > 0

    async def pin(self, memory_id: str) -> bool:
        db = await self._get_db()
        cursor = await db.execute(
            "UPDATE memories SET is_pinned = 1 WHERE id = ?", (memory_id,)
        )
        await db.commit()
        return cursor.rowcount > 0

    async def unpin(self, memory_id: str) -> bool:
        db = await self._get_db()
        cursor = await db.execute(
            "UPDATE memories SET is_pinned = 0 WHERE id = ?", (memory_id,)
        )
        await db.commit()
        return cursor.rowcount > 0

    async def get_pinned(self, character_id: str) -> list[MemoryResponse]:
        db = await self._get_db()
        cursor = await db.execute(
            """
            SELECT * FROM memories
            WHERE character_id = ? AND is_pinned = 1 AND is_deleted = 0
            ORDER BY importance DESC
            """,
            (character_id,),
        )
        rows = await cursor.fetchall()
        return [_row_to_response(r) for r in rows]

    async def update_referenced_at(self, memory_id: str) -> bool:
        db = await self._get_db()
        now = datetime.now(UTC).isoformat()
        cursor = await db.execute(
            "UPDATE memories SET last_referenced_at = ? WHERE id = ?",
            (now, memory_id),
        )
        await db.commit()
        return cursor.rowcount > 0


def _row_to_response(row: aiosqlite.Row) -> MemoryResponse:
    return MemoryResponse(
        id=row["id"],
        character_id=row["character_id"],
        type=row["type"],
        title=row["title"],
        content=row["content"],
        entities=json.loads(row["entities"]),
        tags=json.loads(row["tags"]),
        importance=row["importance"],
        confidence=row["confidence"],
        is_pinned=bool(row["is_pinned"]),
        is_deleted=bool(row["is_deleted"]),
        created_at=row["created_at"],
        last_referenced_at=row["last_referenced_at"],
        source_turn_id=row["source_turn_id"],
    )
