"""Benchmark repository — CRUD operations against SQLite."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.core.repositories.base import BaseRepository
from app.models.benchmark import BenchmarkRunResponse, BenchmarkScoreResponse

if TYPE_CHECKING:
    import aiosqlite


class BenchmarkRepository(BaseRepository):
    async def create_run(
        self, character_id: str, profile_id: str
    ) -> BenchmarkRunResponse:
        db = await self._get_db()
        run_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        await db.execute(
            """
            INSERT INTO benchmark_runs
                (id, character_id, profile_id, status, started_at, summary)
            VALUES (?, ?, ?, 'pending', ?, '{}')
            """,
            (run_id, character_id, profile_id, now),
        )
        await db.commit()
        return await self.get_run(run_id)  # type: ignore[return-value]

    async def get_run(self, run_id: str) -> BenchmarkRunResponse | None:
        db = await self._get_db()
        cursor = await db.execute(
            "SELECT * FROM benchmark_runs WHERE id = ?", (run_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return _row_to_run_response(row)

    async def list_runs(
        self, character_id: str | None = None
    ) -> list[BenchmarkRunResponse]:
        db = await self._get_db()
        if character_id:
            cursor = await db.execute(
                "SELECT * FROM benchmark_runs WHERE character_id = ? "
                "ORDER BY started_at DESC",
                (character_id,),
            )
        else:
            cursor = await db.execute(
                "SELECT * FROM benchmark_runs ORDER BY started_at DESC"
            )
        rows = await cursor.fetchall()
        return [_row_to_run_response(r) for r in rows]

    async def update_run_status(
        self,
        run_id: str,
        status: str,
        summary: dict | None = None,
    ) -> BenchmarkRunResponse | None:
        existing = await self.get_run(run_id)
        if existing is None:
            return None
        db = await self._get_db()

        completed_at = (
            datetime.now(UTC).isoformat()
            if status in ("completed", "failed")
            else existing.completed_at
        )

        if summary is not None:
            await db.execute(
                "UPDATE benchmark_runs SET status = ?, completed_at = ?, "
                "summary = ? WHERE id = ?",
                (status, completed_at, json.dumps(summary), run_id),
            )
        else:
            await db.execute(
                "UPDATE benchmark_runs SET status = ?, completed_at = ? "
                "WHERE id = ?",
                (status, completed_at, run_id),
            )
        await db.commit()
        return await self.get_run(run_id)

    async def add_score(
        self, run_id: str, turn_number: int, scores_dict: dict
    ) -> BenchmarkScoreResponse:
        db = await self._get_db()
        score_id = str(uuid.uuid4())
        await db.execute(
            """
            INSERT INTO benchmark_scores
                (id, run_id, turn_number, persona_score, memory_score,
                 continuity_score, style_score, immersion_score,
                 total_score, details)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                score_id,
                run_id,
                turn_number,
                scores_dict.get("persona_score"),
                scores_dict.get("memory_score"),
                scores_dict.get("continuity_score"),
                scores_dict.get("style_score"),
                scores_dict.get("immersion_score"),
                scores_dict.get("total_score"),
                json.dumps(scores_dict.get("details", {})),
            ),
        )
        await db.commit()
        return await self._get_score(score_id)  # type: ignore[return-value]

    async def _get_score(self, score_id: str) -> BenchmarkScoreResponse | None:
        db = await self._get_db()
        cursor = await db.execute(
            "SELECT * FROM benchmark_scores WHERE id = ?", (score_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return _row_to_score_response(row)

    async def get_scores(self, run_id: str) -> list[BenchmarkScoreResponse]:
        db = await self._get_db()
        cursor = await db.execute(
            "SELECT * FROM benchmark_scores WHERE run_id = ? "
            "ORDER BY turn_number ASC",
            (run_id,),
        )
        rows = await cursor.fetchall()
        return [_row_to_score_response(r) for r in rows]

    async def delete_run(self, run_id: str) -> bool:
        db = await self._get_db()
        cursor = await db.execute(
            "DELETE FROM benchmark_runs WHERE id = ?", (run_id,)
        )
        await db.commit()
        return cursor.rowcount > 0


def _row_to_run_response(row: aiosqlite.Row) -> BenchmarkRunResponse:
    return BenchmarkRunResponse(
        id=row["id"],
        character_id=row["character_id"],
        profile_id=row["profile_id"],
        status=row["status"],
        started_at=row["started_at"],
        completed_at=row["completed_at"],
        summary=json.loads(row["summary"]),
    )


def _row_to_score_response(row: aiosqlite.Row) -> BenchmarkScoreResponse:
    return BenchmarkScoreResponse(
        id=row["id"],
        run_id=row["run_id"],
        turn_number=row["turn_number"],
        persona_score=row["persona_score"],
        memory_score=row["memory_score"],
        continuity_score=row["continuity_score"],
        style_score=row["style_score"],
        immersion_score=row["immersion_score"],
        total_score=row["total_score"],
        details=json.loads(row["details"]),
    )
