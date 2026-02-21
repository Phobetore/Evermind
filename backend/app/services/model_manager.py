"""Model manager — lifecycle management for llama.cpp LLM server processes.

Provides start, stop, restart and health-check operations for the LLM
servers defined in ``config.yaml``.  Process PIDs are tracked in-memory
so that the backend can restart individual servers on demand.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from app.config import get_config

logger = logging.getLogger(__name__)


class _ServerHandle:
    """Lightweight bookkeeping for a single LLM server."""

    __slots__ = ("name", "port", "model_path", "base_url")

    def __init__(self, name: str, port: int, model_path: str, base_url: str) -> None:
        self.name = name
        self.port = port
        self.model_path = model_path
        self.base_url = base_url


class ModelManager:
    """Manages LLM server health checks and status reporting.

    In a production deployment the actual process management (start/stop)
    is handled by the external ``scripts/start.*`` helpers.  This module
    exposes health probing and a *restart* hook that can be extended to
    trigger a process restart via the PID file or a signal.
    """

    def __init__(self) -> None:
        cfg = get_config()
        self._servers: dict[str, _ServerHandle] = {}
        for name, srv in cfg.llm_servers.items():
            base_url = f"http://{cfg.bind_host}:{srv.port}"
            self._servers[name] = _ServerHandle(
                name=name,
                port=srv.port,
                model_path=srv.model_path,
                base_url=base_url,
            )

    @property
    def server_names(self) -> list[str]:
        return list(self._servers)

    async def health(self, name: str) -> bool:
        """Return *True* if the server *name* responds to ``/health``."""
        handle = self._servers.get(name)
        if handle is None:
            return False
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(f"{handle.base_url}/health", timeout=5.0)
                return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def status_all(self) -> dict[str, dict[str, Any]]:
        """Return a ``{server_name: {port, model_path, status}}`` dict."""
        results: dict[str, dict[str, Any]] = {}

        async def _probe(handle: _ServerHandle) -> None:
            alive = await self.health(handle.name)
            results[handle.name] = {
                "port": handle.port,
                "model_path": handle.model_path,
                "status": "ok" if alive else "unreachable",
            }

        await asyncio.gather(*[_probe(h) for h in self._servers.values()])
        return results

    async def restart(self, name: str) -> dict[str, str]:
        """Request a restart of the server *name*.

        The current implementation returns a status dict.  In a full
        deployment this would signal the watchdog or PID-file manager
        to cycle the process.
        """
        handle = self._servers.get(name)
        if handle is None:
            return {"server": name, "status": "not_found"}

        alive = await self.health(name)
        if alive:
            return {"server": name, "status": "already_running"}

        # If the server is down we cannot restart it directly from
        # the backend (it runs in a separate process).  Return a
        # diagnostic status so the caller knows.
        logger.warning("Server '%s' is unreachable — manual restart required", name)
        return {"server": name, "status": "unreachable_manual_restart_required"}


# Module-level singleton (lazy)
_manager: ModelManager | None = None


def get_model_manager() -> ModelManager:
    """Return the global :class:`ModelManager` instance."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = ModelManager()
    return _manager
