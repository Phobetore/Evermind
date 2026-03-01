"""Pydantic models for User Persona CRUD operations."""

from __future__ import annotations

from pydantic import BaseModel, Field


class UserPersonaCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    age: str = ""
    physical_description: str = ""
    personality: str = ""
    backstory: str = ""
    notes: str = ""


class UserPersonaUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    age: str | None = None
    physical_description: str | None = None
    personality: str | None = None
    backstory: str | None = None
    notes: str | None = None


class UserPersonaResponse(BaseModel):
    id: str
    name: str
    age: str
    physical_description: str
    personality: str
    backstory: str
    notes: str
    avatar_path: str
    created_at: str
    updated_at: str
