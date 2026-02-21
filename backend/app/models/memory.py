"""Pydantic models for Memory CRUD operations."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class MemoryCreate(BaseModel):
    character_id: str
    type: Literal["semantic", "episodic", "world"]
    title: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)
    entities: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    importance: float = Field(default=0.5, ge=0.0, le=1.0)
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)
    source_turn_id: str | None = None


class MemoryUpdate(BaseModel):
    title: str | None = None
    content: str | None = None
    entities: list[str] | None = None
    tags: list[str] | None = None
    importance: float | None = Field(default=None, ge=0.0, le=1.0)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class MemoryResponse(BaseModel):
    id: str
    character_id: str
    type: str
    title: str
    content: str
    entities: list[str]
    tags: list[str]
    importance: float
    confidence: float
    is_pinned: bool
    is_deleted: bool
    created_at: str
    last_referenced_at: str | None
    source_turn_id: str | None


class WorldStateResponse(BaseModel):
    character_id: str
    state: dict
    updated_at: str


class WorldStateUpdate(BaseModel):
    state: dict
