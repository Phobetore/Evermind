"""Pydantic models for message variant operations."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class VariantCreate(BaseModel):
    message_id: str
    content: str = Field(..., min_length=1)
    score: float | None = None
    is_selected: bool = False
    meta: dict[str, Any] = Field(default_factory=dict)


class VariantResponse(BaseModel):
    id: str
    message_id: str
    content: str
    score: float | None
    is_selected: bool
    created_at: str
    meta: dict[str, Any]
