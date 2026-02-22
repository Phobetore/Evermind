"""Tool endpoints — LLM-powered utilities."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import get_config
from app.services.chat_service import _resolve_llm_client
from app.tools.character_assistant import generate_character

router = APIRouter(prefix="/tools", tags=["tools"])
logger = logging.getLogger(__name__)

# Maximum wall-clock time the character assistant endpoint may spend waiting
# for the LLM to generate a response before returning a timeout error.
_ASSISTANT_TIMEOUT_SECONDS = 90


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

    # Pre-flight: verify the LLM server is reachable and ready
    status = await llm.health_status()
    if status == "loading":
        raise HTTPException(
            status_code=503,
            detail="LLM server is still loading the model — please try again in a moment",
        )
    if status == "unavailable":
        raise HTTPException(
            status_code=503,
            detail="LLM server is unreachable — please ensure the llama.cpp server is running",
        )

    try:
        result = await asyncio.wait_for(
            generate_character(
                llm,
                name=request.name,
                theme=request.theme,
                relationship=request.relationship,
                style=request.style,
                limits=request.limits,
                notes=request.notes,
            ),
            timeout=_ASSISTANT_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        logger.warning("Character assistant timed out after %ss", _ASSISTANT_TIMEOUT_SECONDS)
        raise HTTPException(
            status_code=504,
            detail=(
                f"Character generation timed out after {_ASSISTANT_TIMEOUT_SECONDS}s "
                "— the LLM server may be overloaded. Please try again."
            ),
        ) from None
    except (
        httpx.ConnectError,
        httpx.ReadError,
        httpx.HTTPStatusError,
        httpx.TimeoutException,
        ConnectionError,
    ):
        logger.exception("Character assistant LLM call failed")
        raise HTTPException(
            status_code=503,
            detail="LLM server is unreachable — cannot generate character",
        ) from None
    except Exception:
        logger.exception("Unexpected error in character assistant")
        raise HTTPException(
            status_code=500,
            detail="Character generation failed unexpectedly — please try again",
        ) from None
    return result
