"""Pydantic models for chat streaming requests."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ChatStreamRequest(BaseModel):
    conversation_id: str
    character_id: str
    user_message: str = Field(..., min_length=1)
    profile_id: str = "balanced"
    generation_params: dict[str, Any] = Field(default_factory=dict)
    regenerate: bool = False
