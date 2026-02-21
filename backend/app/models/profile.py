"""Pydantic models for generation profiles."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ProfileResponse(BaseModel):
    id: str
    chat_server: str
    memory_server: str
    judge_server: str
    best_of_n: int
    self_refine: bool


class ProfileUpdate(BaseModel):
    """Partial update for a generation profile (all fields optional)."""

    chat_server: str | None = None
    memory_server: str | None = None
    judge_server: str | None = None
    best_of_n: int | None = Field(default=None, ge=1, le=7)
    self_refine: bool | None = None
