"""Character repository — CRUD operations against SQLite."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.core.repositories.base import BaseRepository
from app.models.character import (
    CharacterCreate,
    CharacterResponse,
    CharacterUpdate,
)

if TYPE_CHECKING:
    import aiosqlite


class CharacterRepository(BaseRepository):
    async def create(self, data: CharacterCreate) -> CharacterResponse:
        db = await self._get_db()
        now = datetime.now(UTC).isoformat()
        character_id = str(uuid.uuid4())
        await db.execute(
            """
            INSERT INTO characters
                (id, name, tags, summary, persona, writing_style, scenario,
                 first_message, example_dialogues, boundaries, system_rules,
                 memory_seed, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                character_id,
                data.name,
                json.dumps([t for t in data.tags]),
                data.summary,
                data.persona,
                data.writing_style,
                data.scenario,
                data.first_message,
                json.dumps([d.model_dump() for d in data.example_dialogues]),
                data.boundaries,
                data.system_rules,
                json.dumps([m.model_dump() for m in data.memory_seed]),
                now,
                now,
            ),
        )
        await db.commit()
        return await self.get(character_id)  # type: ignore[return-value]

    async def get(self, character_id: str) -> CharacterResponse | None:
        db = await self._get_db()
        cursor = await db.execute("SELECT * FROM characters WHERE id = ?", (character_id,))
        row = await cursor.fetchone()
        if row is None:
            return None
        return _row_to_response(row)

    async def list(self, search: str | None = None) -> list[CharacterResponse]:
        db = await self._get_db()
        if search:
            cursor = await db.execute(
                "SELECT * FROM characters WHERE name LIKE ? ORDER BY updated_at DESC",
                (f"%{search}%",),
            )
        else:
            cursor = await db.execute("SELECT * FROM characters ORDER BY updated_at DESC")
        rows = await cursor.fetchall()
        return [_row_to_response(r) for r in rows]

    async def update(self, character_id: str, data: CharacterUpdate) -> CharacterResponse | None:
        existing = await self.get(character_id)
        if existing is None:
            return None
        db = await self._get_db()
        updates = data.model_dump(exclude_unset=True)
        if not updates:
            return existing
        # Serialise JSON fields
        for field in ("tags", "example_dialogues", "memory_seed"):
            if field in updates:
                items = updates[field]
                updates[field] = json.dumps(
                    [i.model_dump() if hasattr(i, "model_dump") else i for i in items]
                )
        updates["updated_at"] = datetime.now(UTC).isoformat()
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [character_id]
        await db.execute(f"UPDATE characters SET {set_clause} WHERE id = ?", values)
        await db.commit()
        return await self.get(character_id)

    async def delete(self, character_id: str) -> bool:
        db = await self._get_db()
        cursor = await db.execute("DELETE FROM characters WHERE id = ?", (character_id,))
        await db.commit()
        return cursor.rowcount > 0


def _row_to_response(row: aiosqlite.Row) -> CharacterResponse:
    return CharacterResponse(
        id=row["id"],
        name=row["name"],
        tags=json.loads(row["tags"]),
        summary=row["summary"],
        persona=row["persona"],
        writing_style=row["writing_style"],
        scenario=row["scenario"],
        first_message=row["first_message"],
        example_dialogues=json.loads(row["example_dialogues"]),
        boundaries=row["boundaries"],
        system_rules=row["system_rules"],
        memory_seed=json.loads(row["memory_seed"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
