"""Tool endpoints — LLM-powered utilities."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import get_config
from app.services.chat_service import _resolve_llm_client
from app.tools.character_assistant import generate_character

router = APIRouter(prefix="/tools", tags=["tools"])
logger = logging.getLogger(__name__)


class CharacterAssistantRequest(BaseModel):
    """Input for the AI character-generation tool."""

    name: str = Field(..., min_length=1, max_length=200)
    theme: str = ""
    relationship: str = ""
    style: str = ""
    limits: str = ""
    notes: str = ""


@router.post("/character_assistant")
async def character_assistant(request: CharacterAssistantRequest) -> dict[str, Any]:
    """Generate a complete character profile using the chat LLM."""
    cfg = get_config()

    # Use the default chat server for generation
    llm = _resolve_llm_client(cfg, "chat")
    if llm is None:
        raise HTTPException(
            status_code=503,
            detail="Chat LLM server is not configured — cannot generate character",
        )

    try:
        result = await generate_character(
            llm,
            name=request.name,
            theme=request.theme,
            relationship=request.relationship,
            style=request.style,
            limits=request.limits,
            notes=request.notes,
        )
    except Exception:
        logger.exception("Character assistant LLM call failed")
        raise HTTPException(
            status_code=503,
            detail="LLM server is unreachable — cannot generate character",
        ) from None
    return result
