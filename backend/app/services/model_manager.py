"""Model manager — lifecycle management for llama.cpp LLM server processes.

Provides start, stop, restart and health-check operations for the LLM
servers defined in ``config.yaml``.  Process PIDs are tracked in-memory
so that the backend can restart individual servers on demand.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import signal
import sys
from pathlib import Path
from typing import Any

import httpx

from app.config import get_config

logger = logging.getLogger(__name__)

# Common binary names for llama.cpp server
_LLAMA_SERVER_NAMES = (
    "llama-server",
    "llama-server.exe",
    "server",
    "server.exe",
)

# Windows process creation flag for clean shutdown support.
_WIN_CREATE_NEW_PROCESS_GROUP = 0x00000200


def _find_llama_server(configured_path: str) -> str | None:
    """Locate the llama-server binary.

    Search order:
      1. Explicit ``llama_server_path`` from config (if non-empty).
      2. ``bin/`` directory relative to the project root.
      3. System ``PATH``.

    Returns the resolved path string, or *None* if not found.
    """
    # 1. Explicit config path
    if configured_path:
        p = Path(configured_path)
        if p.is_file() and os.access(p, os.X_OK):
            return str(p.resolve())
        # Also try relative to project root
        from app.config import _find_config_path

        project_root = _find_config_path().resolve().parent
        candidate = project_root / configured_path
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)

    # 2. bin/ directory relative to project root
    try:
        from app.config import _find_config_path

        project_root = _find_config_path().resolve().parent
    except Exception:
        project_root = Path.cwd()

    for name in _LLAMA_SERVER_NAMES:
        candidate = project_root / "bin" / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)

    # 3. System PATH
    for name in _LLAMA_SERVER_NAMES:
        found = shutil.which(name)
        if found:
            return found

    return None


class _ServerHandle:
    """Bookkeeping for a single LLM server, including its process."""

    __slots__ = ("name", "port", "model_path", "base_url", "process", "cfg")

    def __init__(self, name: str, port: int, model_path: str, base_url: str, cfg: Any) -> None:
        self.name = name
        self.port = port
        self.model_path = model_path
        self.base_url = base_url
        self.cfg = cfg
        self.process: asyncio.subprocess.Process | None = None


class ModelManager:
    """Manages LLM server processes, health checks, and status reporting.

    When ``auto_start_servers`` is enabled in config and the ``llama-server``
    binary is found, this manager spawns and supervises the LLM server
    processes.  Otherwise it falls back to health-check-only mode (expecting
    externally managed servers).
    """

    def __init__(self) -> None:
        cfg = get_config()
        self._servers: dict[str, _ServerHandle] = {}
        self._llama_binary: str | None = None
        self._auto_start = cfg.auto_start_servers
        self._start_timeout = cfg.server_start_timeout
        self._bind_host = cfg.bind_host

        for name, srv in cfg.llm_servers.items():
            base_url = f"http://{cfg.bind_host}:{srv.port}"
            self._servers[name] = _ServerHandle(
                name=name,
                port=srv.port,
                model_path=srv.model_path,
                base_url=base_url,
                cfg=srv,
            )

        # Locate the binary once at init
        self._llama_binary = _find_llama_server(cfg.llama_server_path)
        if self._llama_binary:
            logger.info("Found llama-server binary: %s", self._llama_binary)
        else:
            logger.info(
                "llama-server binary not found — LLM servers must be started externally"
            )

    @property
    def server_names(self) -> list[str]:
        return list(self._servers)

    @property
    def can_manage_processes(self) -> bool:
        """Return *True* if the manager has a llama-server binary available."""
        return self._llama_binary is not None

    def _build_server_args(self, handle: _ServerHandle) -> list[str]:
        """Build the command-line arguments for llama-server."""
        assert self._llama_binary is not None
        srv = handle.cfg
        # Resolve model path relative to project root
        model_path = Path(srv.model_path)
        if not model_path.is_absolute():
            try:
                from app.config import _find_config_path

                project_root = _find_config_path().resolve().parent
            except Exception:
                project_root = Path.cwd()
            model_path = project_root / model_path

        args = [
            self._llama_binary,
            "--model", str(model_path),
            "--port", str(handle.port),
            "--host", self._bind_host,
            "--ctx-size", str(srv.ctx),
            "--n-gpu-layers", str(srv.n_gpu_layers),
            "--threads", str(srv.threads),
        ]
        return args

    async def start(self, name: str) -> dict[str, str]:
        """Start the LLM server process for *name*.

        Returns a status dict.
        """
        handle = self._servers.get(name)
        if handle is None:
            return {"server": name, "status": "not_found"}

        if handle.process is not None and handle.process.returncode is None:
            return {"server": name, "status": "already_running"}

        if self._llama_binary is None:
            return {"server": name, "status": "no_binary"}

        # Check that the model file exists
        model_path = Path(handle.cfg.model_path)
        if not model_path.is_absolute():
            try:
                from app.config import _find_config_path

                project_root = _find_config_path().resolve().parent
            except Exception:
                project_root = Path.cwd()
            model_path = project_root / model_path

        if not model_path.is_file():
            logger.error(
                "Model file not found for server '%s': %s", name, model_path
            )
            return {"server": name, "status": "model_not_found", "model_path": str(model_path)}

        args = self._build_server_args(handle)
        logger.info("Starting LLM server '%s': %s", name, " ".join(args))

        # Ensure logs directory exists
        try:
            from app.config import _find_config_path

            project_root = _find_config_path().resolve().parent
        except Exception:
            project_root = Path.cwd()
        logs_dir = project_root / "logs"
        logs_dir.mkdir(exist_ok=True)

        log_file = logs_dir / f"llm-{name}.log"
        log_fh = open(log_file, "a")  # noqa: SIM115

        try:
            kwargs: dict[str, Any] = {}
            if sys.platform == "win32":
                kwargs["creationflags"] = _WIN_CREATE_NEW_PROCESS_GROUP

            handle.process = await asyncio.create_subprocess_exec(
                *args,
                stdout=log_fh,
                stderr=log_fh,
                **kwargs,
            )
        except FileNotFoundError:
            logger.error("Failed to start llama-server — binary not executable: %s", args[0])
            return {"server": name, "status": "binary_not_found"}
        except Exception:
            logger.exception("Failed to start LLM server '%s'", name)
            return {"server": name, "status": "start_failed"}
        finally:
            log_fh.close()

        # Wait for health check
        healthy = await self._wait_for_health(name, timeout=self._start_timeout)
        if healthy:
            logger.info("LLM server '%s' is healthy (pid=%s)", name, handle.process.pid)
            return {"server": name, "status": "started", "pid": str(handle.process.pid)}

        logger.warning(
            "LLM server '%s' started (pid=%s) but health check did not pass within %ds",
            name,
            handle.process.pid,
            self._start_timeout,
        )
        return {"server": name, "status": "started_unhealthy", "pid": str(handle.process.pid)}

    async def stop(self, name: str) -> dict[str, str]:
        """Stop the LLM server process for *name*."""
        handle = self._servers.get(name)
        if handle is None:
            return {"server": name, "status": "not_found"}

        proc = handle.process
        if proc is None or proc.returncode is not None:
            handle.process = None
            return {"server": name, "status": "not_running"}

        logger.info("Stopping LLM server '%s' (pid=%s)", name, proc.pid)
        try:
            if sys.platform == "win32":
                proc.terminate()
            else:
                proc.send_signal(signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), timeout=10.0)
            except TimeoutError:
                logger.warning("Server '%s' did not stop in 10s — killing", name)
                proc.kill()
                await proc.wait()
        except ProcessLookupError:
            pass  # already dead

        handle.process = None
        return {"server": name, "status": "stopped"}

    async def start_all(self) -> dict[str, dict[str, str]]:
        """Start all configured LLM servers.

        Returns a dict mapping server name → status dict.
        Servers whose model files are missing are skipped with a warning.
        """
        results: dict[str, dict[str, str]] = {}
        for name in self._servers:
            results[name] = await self.start(name)
        return results

    async def stop_all(self) -> None:
        """Stop all managed LLM server processes."""
        for name in list(self._servers):
            await self.stop(name)

    async def health(self, name: str) -> bool:
        """Return *True* if the server *name* responds to ``/health``."""
        handle = self._servers.get(name)
        if handle is None:
            return False
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(f"{handle.base_url}/health", timeout=5.0)
                return resp.status_code == 200
        except (httpx.HTTPError, OSError):
            return False

    async def status_all(self) -> dict[str, dict[str, Any]]:
        """Return a ``{server_name: {port, model_path, status, managed}}`` dict."""
        results: dict[str, dict[str, Any]] = {}

        async def _probe(handle: _ServerHandle) -> None:
            alive = await self.health(handle.name)
            managed = handle.process is not None and handle.process.returncode is None
            result: dict[str, Any] = {
                "port": handle.port,
                "model_path": handle.model_path,
                "status": "ok" if alive else "unreachable",
                "managed": managed,
            }
            if managed and handle.process is not None:
                result["pid"] = handle.process.pid
            results[handle.name] = result

        await asyncio.gather(*[_probe(h) for h in self._servers.values()])
        return results

    async def restart(self, name: str) -> dict[str, str]:
        """Restart the LLM server *name*.

        If the manager can manage processes, it will stop and re-start the
        server.  Otherwise it returns a diagnostic status.
        """
        handle = self._servers.get(name)
        if handle is None:
            return {"server": name, "status": "not_found"}

        if self.can_manage_processes:
            await self.stop(name)
            return await self.start(name)

        # Fallback: cannot manage processes
        alive = await self.health(name)
        if alive:
            return {"server": name, "status": "already_running"}

        logger.warning("Server '%s' is unreachable — manual restart required", name)
        return {"server": name, "status": "unreachable_manual_restart_required"}

    async def _wait_for_health(self, name: str, *, timeout: int = 120) -> bool:
        """Poll the health endpoint until it responds or *timeout* elapses."""
        elapsed = 0
        interval = 2
        while elapsed < timeout:
            # Check if the process has exited unexpectedly
            handle = self._servers.get(name)
            if handle and handle.process and handle.process.returncode is not None:
                logger.error(
                    "LLM server '%s' exited with code %s during startup",
                    name,
                    handle.process.returncode,
                )
                return False

            if await self.health(name):
                return True
            await asyncio.sleep(interval)
            elapsed += interval
        return False


# Module-level singleton (lazy)
_manager: ModelManager | None = None


def get_model_manager() -> ModelManager:
    """Return the global :class:`ModelManager` instance."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = ModelManager()
    return _manager
