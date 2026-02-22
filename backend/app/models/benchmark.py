"""Pydantic models for Benchmark CRUD operations."""

from __future__ import annotations

from pydantic import BaseModel, Field


class BenchmarkRunCreate(BaseModel):
    character_id: str
    profile_id: str


class BenchmarkRunResponse(BaseModel):
    id: str
    character_id: str
    profile_id: str
    status: str
    started_at: str | None
    completed_at: str | None
    summary: dict


class BenchmarkScoreCreate(BaseModel):
    run_id: str
    turn_number: int = Field(..., ge=0)
    persona_score: float | None = None
    memory_score: float | None = None
    continuity_score: float | None = None
    style_score: float | None = None
    immersion_score: float | None = None
    total_score: float | None = None
    details: dict = Field(default_factory=dict)


class BenchmarkScoreResponse(BaseModel):
    id: str
    run_id: str
    turn_number: int
    persona_score: float | None
    memory_score: float | None
    continuity_score: float | None
    style_score: float | None
    immersion_score: float | None
    total_score: float | None
    details: dict
