"""Pydantic models for Character CRUD operations."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ExampleDialogue(BaseModel):
    user: str
    assistant: str


class MemorySeed(BaseModel):
    content: str
    type: str = "semantic"
    importance: float = 0.5


class CharacterCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    tags: list[str] = Field(default_factory=list)
    summary: str = ""
    persona: str = ""
    writing_style: str = ""
    scenario: str = ""
    first_message: str = ""
    example_dialogues: list[ExampleDialogue] = Field(default_factory=list)
    boundaries: str = ""
    system_rules: str = ""
    memory_seed: list[MemorySeed] = Field(default_factory=list)


class CharacterUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    tags: list[str] | None = None
    summary: str | None = None
    persona: str | None = None
    writing_style: str | None = None
    scenario: str | None = None
    first_message: str | None = None
    example_dialogues: list[ExampleDialogue] | None = None
    boundaries: str | None = None
    system_rules: str | None = None
    memory_seed: list[MemorySeed] | None = None


class CharacterResponse(BaseModel):
    id: str
    name: str
    tags: list[str]
    summary: str
    persona: str
    writing_style: str
    scenario: str
    first_message: str
    example_dialogues: list[ExampleDialogue]
    boundaries: str
    system_rules: str
    memory_seed: list[MemorySeed]
    created_at: str
    updated_at: str
