"""Tests for the /system-info endpoint and GPU detection utilities."""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import Mock, patch

import pytest

from app.core.gpu_info import _parse_vulkaninfo, get_gpu_summary

if TYPE_CHECKING:
    from httpx import AsyncClient


# --- GPU detection utility tests ---


VULKANINFO_SAMPLE = """\
==========
VULKANINFO
==========

Vulkan Instance Version: 1.3.296


Instance Extensions: count = 24

Devices:
========
GPU0:
\tVkPhysicalDeviceProperties:
\t============================
\t\tapiVersion     = 1.3.296 (4206888)
\t\tdriverVersion  = 24.20.0 (100794368)
\t\tdeviceName     = AMD Radeon RX 9070
\t\tdeviceType     = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU

GPU1:
\tVkPhysicalDeviceProperties:
\t============================
\t\tapiVersion     = 1.3.296 (4206888)
\t\tdriverVersion  = 24.20.0 (100794368)
\t\tdeviceName     = AMD Radeon(TM) Graphics
\t\tdeviceType     = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
"""


def test_parse_vulkaninfo_extracts_devices() -> None:
    """_parse_vulkaninfo should extract GPU names from summary output."""
    devices = _parse_vulkaninfo(VULKANINFO_SAMPLE)
    assert len(devices) == 2
    assert devices[0]["name"] == "AMD Radeon RX 9070"
    assert devices[1]["name"] == "AMD Radeon(TM) Graphics"


def test_parse_vulkaninfo_empty_output() -> None:
    """_parse_vulkaninfo should return an empty list for empty input."""
    assert _parse_vulkaninfo("") == []


def test_get_gpu_summary_no_vulkaninfo() -> None:
    """get_gpu_summary should still return a valid dict when vulkaninfo is missing."""
    with patch("app.core.gpu_info.shutil.which", return_value=None):
        result = get_gpu_summary()
    assert result["vulkan_available"] is False
    assert result["devices"] == []
    assert "platform" in result


def test_get_gpu_summary_with_vulkaninfo() -> None:
    """get_gpu_summary should detect devices when vulkaninfo is available."""
    fake_result = Mock(returncode=0, stdout=VULKANINFO_SAMPLE)
    with (
        patch("app.core.gpu_info.shutil.which", return_value="/usr/bin/vulkaninfo"),
        patch("app.core.gpu_info.subprocess.run", return_value=fake_result),
    ):
        result = get_gpu_summary()
    assert result["vulkan_available"] is True
    assert len(result["devices"]) == 2
    assert result["devices"][0]["name"] == "AMD Radeon RX 9070"


# --- /system-info endpoint tests ---


@pytest.mark.asyncio
async def test_system_info_returns_gpu_and_servers(client: AsyncClient) -> None:
    """GET /system-info should return gpu and servers sections."""
    resp = await client.get("/system-info")
    assert resp.status_code == 200
    body = resp.json()
    assert "gpu" in body
    assert "servers" in body

    gpu = body["gpu"]
    assert "platform" in gpu
    assert "vulkan_available" in gpu
    assert isinstance(gpu["devices"], list)

    # servers will be empty since no real llama-server is running in tests
    assert isinstance(body["servers"], dict)
