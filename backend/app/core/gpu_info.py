"""GPU and Vulkan device detection utilities.

Gathers information about available GPU devices on the host system so
that the backend can expose it through the ``/system-info`` endpoint.
"""

from __future__ import annotations

import logging
import platform
import shutil
import subprocess

logger = logging.getLogger(__name__)


def detect_vulkan_devices() -> list[dict[str, str]]:
    """Detect Vulkan-capable GPU devices using ``vulkaninfo``.

    Returns a list of dicts, each with at least a ``"name"`` key and
    optionally ``"driver_version"`` and ``"api_version"``.
    """
    if not shutil.which("vulkaninfo"):
        return []

    try:
        result = subprocess.run(  # noqa: S603, S607
            ["vulkaninfo", "--summary"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return []
        return _parse_vulkaninfo(result.stdout)
    except (subprocess.TimeoutExpired, OSError):
        logger.debug("vulkaninfo not available or timed out")
        return []


def _parse_vulkaninfo(output: str) -> list[dict[str, str]]:
    """Parse ``vulkaninfo --summary`` output into a list of GPU entries."""
    devices: list[dict[str, str]] = []
    current: dict[str, str] = {}

    for line in output.splitlines():
        stripped = line.strip()

        # Each GPU block starts with a line like "GPU0:" or "GPU1:"
        if stripped.startswith("GPU") and stripped.endswith(":") and stripped[3:-1].isdigit():
            if current:
                devices.append(current)
            current = {}
            continue

        if "=" in stripped:
            key, _, value = stripped.partition("=")
            key = key.strip()
            value = value.strip()

            key_lower = key.lower()
            if "devicename" in key_lower or "device name" in key_lower:
                current["name"] = value
            elif "driverversion" in key_lower or "driver version" in key_lower:
                current["driver_version"] = value
            elif "apiversion" in key_lower or "api version" in key_lower:
                current["api_version"] = value
            elif "devicetype" in key_lower or "device type" in key_lower:
                current["device_type"] = value

    if current:
        devices.append(current)

    return devices


def get_gpu_summary() -> dict:
    """Return a summary of GPU / Vulkan availability on this host.

    The returned dict contains:
    - ``platform``: OS name (e.g. "Linux", "Windows")
    - ``vulkan_available``: whether ``vulkaninfo`` was found
    - ``devices``: list of detected Vulkan GPU devices
    """
    vulkan_available = shutil.which("vulkaninfo") is not None
    devices = detect_vulkan_devices() if vulkan_available else []

    return {
        "platform": platform.system(),
        "vulkan_available": vulkan_available,
        "devices": devices,
    }
