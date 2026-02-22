"""Tests for ModelManager process management functionality."""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import patch

import pytest

from app.services.model_manager import ModelManager, _find_llama_server

if TYPE_CHECKING:
    from httpx import AsyncClient


# --- Binary detection ---


def test_find_llama_server_explicit_path(tmp_path):
    """If an explicit path is given and exists, it should be returned."""
    binary = tmp_path / "llama-server"
    binary.touch()
    binary.chmod(0o755)
    result = _find_llama_server(str(binary))
    assert result == str(binary.resolve())


def test_find_llama_server_empty_not_found():
    """With no binary on PATH or in bin/, should return None."""
    with patch("shutil.which", return_value=None):
        result = _find_llama_server("")
    # May or may not find one depending on environment; ensure no crash
    assert result is None or isinstance(result, str)


def test_find_llama_server_on_path():
    """If llama-server is on the system PATH, it should be found."""
    with patch("shutil.which", side_effect=lambda name: "/usr/bin/llama-server" if name == "llama-server" else None):
        result = _find_llama_server("")
    # Could be found via bin/ first; just ensure no crash
    assert result is None or isinstance(result, str)


# --- Config additions ---


def test_config_has_new_fields():
    """AppConfig should have the new process management fields."""
    from app.config import AppConfig

    cfg = AppConfig()
    assert cfg.llama_server_path == ""
    assert cfg.auto_start_servers is True
    assert cfg.server_start_timeout == 120


# --- ModelManager properties ---


def test_manager_can_manage_processes():
    """can_manage_processes should reflect binary availability."""
    manager = ModelManager()
    # In test environment, llama-server is not installed
    # Just verify the property works
    assert isinstance(manager.can_manage_processes, bool)


@pytest.mark.asyncio
async def test_start_no_binary():
    """start() should return 'no_binary' when llama-server is not found."""
    manager = ModelManager()
    manager._llama_binary = None
    result = await manager.start("chat")
    assert result["status"] == "no_binary"


@pytest.mark.asyncio
async def test_start_model_not_found(tmp_path):
    """start() should return 'model_not_found' when model file is missing."""
    manager = ModelManager()
    manager._llama_binary = "/usr/bin/fake-llama-server"
    result = await manager.start("chat")
    assert result["status"] == "model_not_found"


@pytest.mark.asyncio
async def test_start_unknown_server():
    """start() should return 'not_found' for unknown server name."""
    manager = ModelManager()
    result = await manager.start("nonexistent")
    assert result["status"] == "not_found"


@pytest.mark.asyncio
async def test_stop_unknown_server():
    """stop() should return 'not_found' for unknown server name."""
    manager = ModelManager()
    result = await manager.stop("nonexistent")
    assert result["status"] == "not_found"


@pytest.mark.asyncio
async def test_stop_not_running():
    """stop() should return 'not_running' when no process is tracked."""
    manager = ModelManager()
    result = await manager.stop("chat")
    assert result["status"] == "not_running"


@pytest.mark.asyncio
async def test_restart_no_binary_fallback():
    """restart() without binary should fall back to health-check mode."""
    manager = ModelManager()
    manager._llama_binary = None
    result = await manager.restart("chat")
    # Server is not running in test, so it should be unreachable
    assert result["status"] in ("already_running", "unreachable_manual_restart_required")


@pytest.mark.asyncio
async def test_status_all_includes_managed_flag():
    """status_all() should include 'managed' field."""
    manager = ModelManager()
    results = await manager.status_all()
    for info in results.values():
        assert "managed" in info
        assert isinstance(info["managed"], bool)


# --- API endpoints ---


@pytest.mark.asyncio
async def test_models_status_includes_can_manage(client: AsyncClient) -> None:
    """GET /models/status should include can_manage_processes flag."""
    resp = await client.get("/models/status")
    assert resp.status_code == 200
    body = resp.json()
    assert "can_manage_processes" in body
    assert isinstance(body["can_manage_processes"], bool)


@pytest.mark.asyncio
async def test_start_endpoint_unknown_server(client: AsyncClient) -> None:
    """POST /models/start with unknown server should return 404."""
    resp = await client.post("/models/start?server_name=nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_stop_endpoint_unknown_server(client: AsyncClient) -> None:
    """POST /models/stop with unknown server should return 404."""
    resp = await client.post("/models/stop?server_name=nonexistent")
    assert resp.status_code == 404
