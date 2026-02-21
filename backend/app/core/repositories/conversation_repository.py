"""Conversation repository — CRUD operations against SQLite."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.core.repositories.base import BaseRepository
from app.models.conversation import ConversationCreate, ConversationResponse

if TYPE_CHECKING:
    import aiosqlite


class ConversationRepository(BaseRepository):
    async def create(self, data: ConversationCreate) -> ConversationResponse:
        db = await self._get_db()
        now = datetime.now(UTC).isoformat()
        conversation_id = str(uuid.uuid4())
        await db.execute(
            """
            INSERT INTO conversations (id, character_id, title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (conversation_id, data.character_id, data.title, now, now),
        )
        await db.commit()
        return await self.get(conversation_id)  # type: ignore[return-value]

    async def get(self, conversation_id: str) -> ConversationResponse | None:
        db = await self._get_db()
        cursor = await db.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,))
        row = await cursor.fetchone()
        if row is None:
            return None
        return _row_to_response(row)

    async def list_by_character(self, character_id: str) -> list[ConversationResponse]:
        db = await self._get_db()
        cursor = await db.execute(
            "SELECT * FROM conversations WHERE character_id = ? ORDER BY updated_at DESC",
            (character_id,),
        )
        rows = await cursor.fetchall()
        return [_row_to_response(r) for r in rows]

    async def delete(self, conversation_id: str) -> bool:
        db = await self._get_db()
        cursor = await db.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
        await db.commit()
        return cursor.rowcount > 0


def _row_to_response(row: aiosqlite.Row) -> ConversationResponse:
    return ConversationResponse(
        id=row["id"],
        character_id=row["character_id"],
        title=row["title"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
