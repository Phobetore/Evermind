"""Model status endpoint — GET /models/status."""

from __future__ import annotations

import asyncio
import logging

import httpx
from fastapi import APIRouter

from app.config import get_config

router = APIRouter(prefix="/models", tags=["models"])

logger = logging.getLogger(__name__)


@router.get("/status")
async def models_status() -> dict:
    """Return the health status of every configured LLM server."""
    cfg = get_config()
    results: dict[str, dict] = {}

    async def _check(client: httpx.AsyncClient, name: str, port: int) -> None:
        base_url = f"http://{cfg.bind_host}:{port}"
        try:
            resp = await client.get(f"{base_url}/health", timeout=5.0)
            healthy = resp.status_code == 200
        except httpx.HTTPError:
            healthy = False
        results[name] = {
            "port": port,
            "status": "ok" if healthy else "unreachable",
        }

    async with httpx.AsyncClient() as client:
        tasks = [_check(client, name, srv.port) for name, srv in cfg.llm_servers.items()]
        await asyncio.gather(*tasks)

    return {"servers": results}
