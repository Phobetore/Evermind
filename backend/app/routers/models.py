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
    return {"servers": servers, "can_manage_processes": manager.can_manage_processes}


@router.post("/start")
async def start_model(server_name: str) -> dict:
    """Start a specific LLM server by name."""
    manager = get_model_manager()
    if server_name not in manager.server_names:
        raise HTTPException(status_code=404, detail=f"Server '{server_name}' not configured")
    if not manager.can_manage_processes:
        raise HTTPException(
            status_code=501,
            detail="Cannot start servers — llama-server binary not found",
        )
    result = await manager.start(server_name)
    return result


@router.post("/stop")
async def stop_model(server_name: str) -> dict:
    """Stop a specific LLM server by name."""
    manager = get_model_manager()
    if server_name not in manager.server_names:
        raise HTTPException(status_code=404, detail=f"Server '{server_name}' not configured")
    result = await manager.stop(server_name)
    return result


@router.post("/restart")
async def restart_model(server_name: str) -> dict:
    """Request a restart of a specific LLM server by name."""
    manager = get_model_manager()
    if server_name not in manager.server_names:
        raise HTTPException(status_code=404, detail=f"Server '{server_name}' not configured")
    result = await manager.restart(server_name)
    return result
