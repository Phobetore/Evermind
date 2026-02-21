"""Pydantic models for Message CRUD operations."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class MessageCreate(BaseModel):
    conversation_id: str
    role: Literal["user", "assistant", "system"] = "user"
    content: str = Field(..., min_length=1)
    meta: dict[str, Any] = Field(default_factory=dict)


class MessageResponse(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    created_at: str
    meta: dict[str, Any]
