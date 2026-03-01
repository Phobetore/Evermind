"""User persona repository — CRUD operations against SQLite."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.core.repositories.base import BaseRepository
from app.models.user_persona import UserPersonaCreate, UserPersonaResponse, UserPersonaUpdate

if TYPE_CHECKING:
    import aiosqlite


class UserPersonaRepository(BaseRepository):
    async def create(self, data: UserPersonaCreate) -> UserPersonaResponse:
        db = await self._get_db()
        now = datetime.now(UTC).isoformat()
        persona_id = str(uuid.uuid4())
        await db.execute(
            """
            INSERT INTO user_personas
                (id, name, age, physical_description, personality, backstory, notes,
                 avatar_path, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)
            """,
            (
                persona_id,
                data.name,
                data.age,
                data.physical_description,
                data.personality,
                data.backstory,
                data.notes,
                now,
                now,
            ),
        )
        await db.commit()
        return await self.get(persona_id)  # type: ignore[return-value]

    async def get(self, persona_id: str) -> UserPersonaResponse | None:
        db = await self._get_db()
        cursor = await db.execute("SELECT * FROM user_personas WHERE id = ?", (persona_id,))
        row = await cursor.fetchone()
        if row is None:
            return None
        return _row_to_response(row)

    async def list_all(self) -> list[UserPersonaResponse]:
        db = await self._get_db()
        cursor = await db.execute("SELECT * FROM user_personas ORDER BY updated_at DESC")
        rows = await cursor.fetchall()
        return [_row_to_response(r) for r in rows]

    async def update(self, persona_id: str, data: UserPersonaUpdate) -> UserPersonaResponse | None:
        existing = await self.get(persona_id)
        if existing is None:
            return None
        db = await self._get_db()
        updates = data.model_dump(exclude_unset=True)
        if not updates:
            return existing
        updates["updated_at"] = datetime.now(UTC).isoformat()
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [persona_id]
        await db.execute(f"UPDATE user_personas SET {set_clause} WHERE id = ?", values)
        await db.commit()
        return await self.get(persona_id)

    async def set_avatar(self, persona_id: str, avatar_path: str) -> UserPersonaResponse | None:
        """Update the avatar_path for a persona."""
        existing = await self.get(persona_id)
        if existing is None:
            return None
        db = await self._get_db()
        now = datetime.now(UTC).isoformat()
        await db.execute(
            "UPDATE user_personas SET avatar_path = ?, updated_at = ? WHERE id = ?",
            (avatar_path, now, persona_id),
        )
        await db.commit()
        return await self.get(persona_id)

    async def delete(self, persona_id: str) -> bool:
        db = await self._get_db()
        cursor = await db.execute("DELETE FROM user_personas WHERE id = ?", (persona_id,))
        await db.commit()
        return cursor.rowcount > 0


def _row_to_response(row: aiosqlite.Row) -> UserPersonaResponse:
    return UserPersonaResponse(
        id=row["id"],
        name=row["name"],
        age=row["age"],
        physical_description=row["physical_description"],
        personality=row["personality"],
        backstory=row["backstory"],
        notes=row["notes"],
        avatar_path=row["avatar_path"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
