"""Message repository — CRUD operations against SQLite."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from app.core.repositories.base import BaseRepository
from app.models.message import MessageCreate, MessageResponse

if TYPE_CHECKING:
    import aiosqlite


class MessageRepository(BaseRepository):
    async def create(self, data: MessageCreate) -> MessageResponse:
        db = await self._get_db()
        now = datetime.now(UTC).isoformat()
        message_id = str(uuid.uuid4())
        await db.execute(
            """
            INSERT INTO messages (id, conversation_id, role, content, created_at, meta)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                message_id,
                data.conversation_id,
                data.role,
                data.content,
                now,
                json.dumps(data.meta),
            ),
        )
        await db.commit()
        return await self.get(message_id)  # type: ignore[return-value]

    async def get(self, message_id: str) -> MessageResponse | None:
        db = await self._get_db()
        cursor = await db.execute("SELECT * FROM messages WHERE id = ?", (message_id,))
        row = await cursor.fetchone()
        if row is None:
            return None
        return _row_to_response(row)

    async def list_by_conversation(
        self,
        conversation_id: str,
        limit: int = 50,
        offset: int = 0,
    ) -> list[MessageResponse]:
        db = await self._get_db()
        cursor = await db.execute(
            """
            SELECT * FROM messages
            WHERE conversation_id = ?
            ORDER BY created_at ASC
            LIMIT ? OFFSET ?
            """,
            (conversation_id, limit, offset),
        )
        rows = await cursor.fetchall()
        return [_row_to_response(r) for r in rows]

    async def delete_last_assistant_message(self, conversation_id: str) -> None:
        """Delete the most recent assistant message in a conversation."""
        db = await self._get_db()
        await db.execute(
            """
            DELETE FROM messages
            WHERE id = (
                SELECT id FROM messages
                WHERE conversation_id = ? AND role = 'assistant'
                ORDER BY created_at DESC
                LIMIT 1
            )
            """,
            (conversation_id,),
        )
        await db.commit()

    async def get_recent(
        self,
        conversation_id: str,
        limit: int = 20,
    ) -> list[MessageResponse]:
        db = await self._get_db()
        cursor = await db.execute(
            """
            SELECT * FROM (
                SELECT * FROM messages
                WHERE conversation_id = ?
                ORDER BY created_at DESC
                LIMIT ?
            ) sub ORDER BY created_at ASC
            """,
            (conversation_id, limit),
        )
        rows = await cursor.fetchall()
        return [_row_to_response(r) for r in rows]


def _row_to_response(row: aiosqlite.Row) -> MessageResponse:
    meta_raw: Any = row["meta"]
    meta = json.loads(meta_raw) if isinstance(meta_raw, str) else meta_raw or {}
    return MessageResponse(
        id=row["id"],
        conversation_id=row["conversation_id"],
        role=row["role"],
        content=row["content"],
        created_at=row["created_at"],
        meta=meta,
    )
