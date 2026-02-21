"""Model status endpoint — GET /models/status."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter

from app.config import get_config
from app.core.llm_client import LLMClient

router = APIRouter(prefix="/models", tags=["models"])

logger = logging.getLogger(__name__)


@router.get("/status")
async def models_status() -> dict:
    """Return the health status of every configured LLM server."""
    cfg = get_config()
    results: dict[str, dict] = {}

    async def _check(name: str, port: int) -> None:
        base_url = f"http://{cfg.bind_host}:{port}"
        client = LLMClient(base_url=base_url, timeout=5.0)
        healthy = await client.health()
        results[name] = {
            "port": port,
            "status": "ok" if healthy else "unreachable",
        }

    tasks = [_check(name, srv.port) for name, srv in cfg.llm_servers.items()]
    await asyncio.gather(*tasks)

    return {"servers": results}
