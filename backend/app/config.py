"""Application configuration loaded from config.yaml and environment variables."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class LLMServerConfig(BaseModel):
    port: int
    model_path: str
    ctx: int = 8192
    n_gpu_layers: int = -1
    backend: str = "vulkan"
    quant: str = "q4_k_m"
    threads: int = 4
    timeout: float = 120.0  # per-server request timeout in seconds


class EmbeddingsConfig(BaseModel):
    model_name: str = "intfloat/e5-small-v2"
    device: str = "cpu"
    dimension: int = 384


class ProfileConfig(BaseModel):
    chat_server: str = "chat"
    memory_server: str = "memory"
    judge_server: str = "judge"
    best_of_n: int = 3
    self_refine: bool = True


class LoggingConfig(BaseModel):
    level: str = "INFO"
    dir: str = "logs/"


class AppConfig(BaseModel):
    """Root configuration model."""

    bind_host: str = "127.0.0.1"
    frontend_port: int = 3000
    backend_port: int = 8000
    llm_servers: dict[str, LLMServerConfig] = Field(default_factory=dict)
    embeddings: EmbeddingsConfig = Field(default_factory=EmbeddingsConfig)
    profiles: dict[str, ProfileConfig] = Field(default_factory=dict)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)


def _find_config_path() -> Path:
    """Locate config.yaml relative to the backend directory."""
    env_path = os.getenv("EVERMIND_CONFIG")
    if env_path:
        return Path(env_path)
    # Look in common locations
    candidates = [
        Path("config.yaml"),
        Path("../config.yaml"),
        Path(__file__).resolve().parents[2] / "config.yaml",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return Path("config.yaml")


def load_config(path: Path | None = None) -> AppConfig:
    """Load and validate configuration from a YAML file."""
    config_path = path or _find_config_path()
    if config_path.is_file():
        with open(config_path) as f:
            raw: dict[str, Any] = yaml.safe_load(f) or {}
        return AppConfig.model_validate(raw)
    return AppConfig()


# Singleton — lazily initialised via ``get_config()``.
_config: AppConfig | None = None


def get_config() -> AppConfig:
    """Return the global application config (loaded once)."""
    global _config  # noqa: PLW0603
    if _config is None:
        _config = load_config()
    return _config
