"""Message variant repository — CRUD operations against SQLite."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from app.core.repositories.base import BaseRepository
from app.models.variant import VariantCreate, VariantResponse

if TYPE_CHECKING:
    import aiosqlite


class VariantRepository(BaseRepository):
    async def create(self, data: VariantCreate) -> VariantResponse:
        db = await self._get_db()
        variant_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        await db.execute(
            """
            INSERT INTO message_variants
                (id, message_id, content, score, is_selected, created_at, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                variant_id,
                data.message_id,
                data.content,
                data.score,
                int(data.is_selected),
                now,
                json.dumps(data.meta),
            ),
        )
        await db.commit()
        return await self.get(variant_id)  # type: ignore[return-value]

    async def get(self, variant_id: str) -> VariantResponse | None:
        db = await self._get_db()
        cursor = await db.execute(
            "SELECT * FROM message_variants WHERE id = ?", (variant_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return _row_to_response(row)

    async def list_by_message(self, message_id: str) -> list[VariantResponse]:
        db = await self._get_db()
        cursor = await db.execute(
            "SELECT * FROM message_variants WHERE message_id = ? "
            "ORDER BY created_at ASC",
            (message_id,),
        )
        rows = await cursor.fetchall()
        return [_row_to_response(r) for r in rows]

    async def select(self, variant_id: str) -> VariantResponse | None:
        """Mark a variant as selected and deselect all siblings."""
        variant = await self.get(variant_id)
        if variant is None:
            return None
        db = await self._get_db()
        # Deselect all variants for the same message
        await db.execute(
            "UPDATE message_variants SET is_selected = 0 WHERE message_id = ?",
            (variant.message_id,),
        )
        # Select the target variant
        await db.execute(
            "UPDATE message_variants SET is_selected = 1 WHERE id = ?",
            (variant_id,),
        )
        await db.commit()
        return await self.get(variant_id)

    async def delete(self, variant_id: str) -> bool:
        db = await self._get_db()
        cursor = await db.execute(
            "DELETE FROM message_variants WHERE id = ?", (variant_id,)
        )
        await db.commit()
        return cursor.rowcount > 0


def _row_to_response(row: aiosqlite.Row) -> VariantResponse:
    meta_raw: Any = row["meta"]
    meta = json.loads(meta_raw) if isinstance(meta_raw, str) else meta_raw or {}
    return VariantResponse(
        id=row["id"],
        message_id=row["message_id"],
        content=row["content"],
        score=row["score"],
        is_selected=bool(row["is_selected"]),
        created_at=row["created_at"],
        meta=meta,
    )
