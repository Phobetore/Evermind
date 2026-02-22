"""Health and version endpoints."""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok"}


@router.get("/version")
async def version() -> dict[str, str]:
    """Return the application version."""
    return {"version": "0.2.0", "name": "evermind-backend"}
