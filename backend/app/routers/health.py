"""Health, version, and system information endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.core.gpu_info import get_gpu_summary
from app.services.model_manager import get_model_manager

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok"}


@router.get("/version")
async def version() -> dict[str, str]:
    """Return the application version."""
    return {"version": "0.2.0", "name": "evermind-backend"}


@router.get("/system-info")
async def system_info() -> dict[str, Any]:
    """Return system information including GPU/Vulkan devices and LLM server props."""
    gpu = get_gpu_summary()
    manager = get_model_manager()
    server_props = await manager.system_info_all()

    return {
        "gpu": gpu,
        "servers": server_props,
    }
