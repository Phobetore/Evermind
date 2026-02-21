"""Pydantic models for generation profiles."""

from __future__ import annotations

from pydantic import BaseModel


class ProfileResponse(BaseModel):
    id: str
    chat_server: str
    memory_server: str
    judge_server: str
    best_of_n: int
    self_refine: bool
