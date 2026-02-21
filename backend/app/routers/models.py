"""Model status and management endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from app.services.model_manager import get_model_manager

router = APIRouter(prefix="/models", tags=["models"])

logger = logging.getLogger(__name__)


@router.get("/status")
async def models_status() -> dict:
    """Return the health status of every configured LLM server."""
    manager = get_model_manager()
    servers = await manager.status_all()
    return {"servers": servers}


@router.post("/restart")
async def restart_model(server_name: str) -> dict:
    """Request a restart of a specific LLM server by name."""
    manager = get_model_manager()
    if server_name not in manager.server_names:
        raise HTTPException(status_code=404, detail=f"Server '{server_name}' not configured")
    result = await manager.restart(server_name)
    return result
