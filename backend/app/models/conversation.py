"""Pydantic models for Conversation CRUD operations."""

from __future__ import annotations

from pydantic import BaseModel


class ConversationCreate(BaseModel):
    character_id: str
    title: str = ""
    user_persona_id: str | None = None


class ConversationUpdate(BaseModel):
    title: str


class ConversationResponse(BaseModel):
    id: str
    character_id: str
    title: str
    user_persona_id: str | None = None
    created_at: str
    updated_at: str
