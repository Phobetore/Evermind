"""Tool endpoints — LLM-powered utilities."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import get_config
from app.services.chat_service import _resolve_llm_client
from app.tools.character_assistant import (
    generate_character_stream,
    parse_assistant_response,
)

router = APIRouter(prefix="/tools", tags=["tools"])
logger = logging.getLogger(__name__)


def _sse(data: dict[str, Any]) -> str:
    """Format a dict as an SSE ``data:`` frame."""
    return f"data: {json.dumps(data)}\n\n"


class CharacterAssistantRequest(BaseModel):
    """Input for the AI character-generation tool."""

    name: str = Field(..., min_length=1, max_length=200)
    theme: str = ""
    relationship: str = ""
    style: str = ""
    limits: str = ""
    notes: str = ""


@router.post("/character_assistant")
async def character_assistant(request: CharacterAssistantRequest) -> StreamingResponse:
    """Generate a complete character profile using the chat LLM.

    Returns a **Server-Sent Events** stream so that data flows
    continuously from backend → frontend, preventing idle-connection
    timeouts in the proxy chain.

    Events emitted:

    - ``{"token": "..."}`` — a raw token from the LLM
    - ``{"done": true, "result": {...}}`` — the final parsed character
    - ``{"error": "..."}`` — on failure
    """
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

    async def _event_stream():
        tokens: list[str] = []
        try:
            async for token in generate_character_stream(
                llm,
                name=request.name,
                theme=request.theme,
                relationship=request.relationship,
                style=request.style,
                limits=request.limits,
                notes=request.notes,
            ):
                tokens.append(token)
                yield _sse({"token": token})
        except (
            httpx.ConnectError,
            httpx.ReadError,
            httpx.HTTPStatusError,
            httpx.TimeoutException,
            ConnectionError,
        ):
            logger.exception("Character assistant LLM call failed")
            yield _sse({"error": "LLM server is unreachable — cannot generate character"})
            return
        except Exception:
            logger.exception("Unexpected error in character assistant")
            yield _sse({"error": "Character generation failed unexpectedly — please try again"})
            return

        raw = "".join(tokens)
        result = parse_assistant_response(raw)
        if not result.get("name"):
            result["name"] = request.name
        yield _sse({"done": True, "result": result})

    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
