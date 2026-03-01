"""Conversation repository — CRUD operations against SQLite."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.core.repositories.base import BaseRepository
from app.models.conversation import ConversationCreate, ConversationResponse, ConversationUpdate

if TYPE_CHECKING:
    import aiosqlite


class ConversationRepository(BaseRepository):
    async def create(self, data: ConversationCreate) -> ConversationResponse:
        db = await self._get_db()
        now = datetime.now(UTC).isoformat()
        conversation_id = str(uuid.uuid4())
        await db.execute(
            """
            INSERT INTO conversations (id, character_id, title, user_persona_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (conversation_id, data.character_id, data.title, data.user_persona_id, now, now),
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

    async def list_all(self) -> list[ConversationResponse]:
        db = await self._get_db()
        cursor = await db.execute("SELECT * FROM conversations ORDER BY updated_at DESC")
        rows = await cursor.fetchall()
        return [_row_to_response(r) for r in rows]

    async def list_by_character(self, character_id: str) -> list[ConversationResponse]:
        db = await self._get_db()
        cursor = await db.execute(
            "SELECT * FROM conversations WHERE character_id = ? ORDER BY updated_at DESC",
            (character_id,),
        )
        rows = await cursor.fetchall()
        return [_row_to_response(r) for r in rows]

    async def update(self, conversation_id: str, data: ConversationUpdate) -> ConversationResponse | None:
        db = await self._get_db()
        now = datetime.now(UTC).isoformat()
        cursor = await db.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            (data.title, now, conversation_id),
        )
        await db.commit()
        if cursor.rowcount == 0:
            return None
        return await self.get(conversation_id)

    async def delete(self, conversation_id: str) -> bool:
        db = await self._get_db()
        cursor = await db.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
        await db.commit()
        return cursor.rowcount > 0


def _row_to_response(row: aiosqlite.Row) -> ConversationResponse:
    keys = row.keys()
    return ConversationResponse(
        id=row["id"],
        character_id=row["character_id"],
        title=row["title"],
        user_persona_id=row["user_persona_id"] if "user_persona_id" in keys else None,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
