"""Tests for config validation utility."""

from __future__ import annotations

import tempfile
from pathlib import Path

import yaml

from app.config import load_config
from app.validate_config import _check_port_free, _validate_config


def _write_config(cfg_dict: dict, tmp_dir: str) -> Path:
    """Write a config dict to a temp YAML file and return its path."""
    path = Path(tmp_dir) / "config.yaml"
    with open(path, "w") as f:
        yaml.dump(cfg_dict, f)
    return path


# Minimal valid configuration for testing.
_VALID_CONFIG: dict = {
    "bind_host": "127.0.0.1",
    "backend_port": 18000,
    "frontend_port": 13000,
    "llm_servers": {
        "chat": {
            "port": 18081,
            "model_path": "models/chat/test.gguf",
            "ctx": 4096,
        },
        "memory": {
            "port": 18082,
            "model_path": "models/memory/test.gguf",
            "ctx": 4096,
        },
        "judge": {
            "port": 18083,
            "model_path": "models/judge/test.gguf",
            "ctx": 4096,
        },
    },
    "embeddings": {
        "model_name": "intfloat/e5-small-v2",
        "device": "cpu",
        "dimension": 384,
    },
    "profiles": {
        "balanced": {
            "chat_server": "chat",
            "memory_server": "memory",
            "judge_server": "judge",
            "best_of_n": 3,
            "self_refine": True,
        },
    },
    "logging": {"level": "INFO", "dir": "logs/"},
}


def test_valid_config_no_issues():
    """A well-formed config should produce zero issues."""
    with tempfile.TemporaryDirectory() as tmp:
        path = _write_config(_VALID_CONFIG, tmp)
        cfg = load_config(path)
        issues = _validate_config(cfg)
        assert issues == []


def test_port_conflict_between_servers():
    """Two servers sharing a port should be flagged."""
    raw = {**_VALID_CONFIG}
    raw["llm_servers"] = {
        "chat": {"port": 18081, "model_path": "x.gguf", "ctx": 4096},
        "memory": {"port": 18081, "model_path": "y.gguf", "ctx": 4096},
    }
    with tempfile.TemporaryDirectory() as tmp:
        path = _write_config(raw, tmp)
        cfg = load_config(path)
        issues = _validate_config(cfg)
        assert any("Port conflict" in i for i in issues)


def test_profile_references_unknown_server():
    """A profile referencing a non-existent server should be flagged."""
    raw = {**_VALID_CONFIG}
    raw["profiles"] = {
        "bad": {
            "chat_server": "nonexistent",
            "memory_server": "memory",
            "judge_server": "judge",
            "best_of_n": 1,
            "self_refine": False,
        },
    }
    with tempfile.TemporaryDirectory() as tmp:
        path = _write_config(raw, tmp)
        cfg = load_config(path)
        issues = _validate_config(cfg)
        assert any("unknown server" in i for i in issues)


def test_no_servers_configured():
    """An empty llm_servers section should be flagged."""
    raw = {**_VALID_CONFIG, "llm_servers": {}}
    with tempfile.TemporaryDirectory() as tmp:
        path = _write_config(raw, tmp)
        cfg = load_config(path)
        issues = _validate_config(cfg)
        assert any("No LLM servers" in i for i in issues)


def test_invalid_logging_level():
    """An invalid logging level should be flagged."""
    raw = {**_VALID_CONFIG, "logging": {"level": "VERBOSE", "dir": "logs/"}}
    with tempfile.TemporaryDirectory() as tmp:
        path = _write_config(raw, tmp)
        cfg = load_config(path)
        issues = _validate_config(cfg)
        assert any("Invalid logging level" in i for i in issues)


def test_backend_frontend_llm_port_collision():
    """Backend port colliding with an LLM port should be flagged."""
    raw = {**_VALID_CONFIG, "backend_port": 18081}
    with tempfile.TemporaryDirectory() as tmp:
        path = _write_config(raw, tmp)
        cfg = load_config(path)
        issues = _validate_config(cfg)
        assert any("Port conflict" in i for i in issues)


def test_check_port_free_on_unused_port():
    """An unused high port should be reported as free."""
    # Port 0 lets the OS pick a free port, so 59999 is very likely free.
    assert _check_port_free("127.0.0.1", 59999) is True


def test_low_ctx_warning():
    """A very low ctx value should be flagged."""
    raw = {**_VALID_CONFIG}
    raw["llm_servers"] = {
        "chat": {"port": 18081, "model_path": "x.gguf", "ctx": 128},
    }
    with tempfile.TemporaryDirectory() as tmp:
        path = _write_config(raw, tmp)
        cfg = load_config(path)
        issues = _validate_config(cfg)
        assert any("ctx" in i and "low" in i for i in issues)


def test_empty_embeddings_model_name():
    """An empty embeddings model_name should be flagged."""
    raw = {**_VALID_CONFIG}
    raw["embeddings"] = {"model_name": "", "device": "cpu", "dimension": 384}
    with tempfile.TemporaryDirectory() as tmp:
        path = _write_config(raw, tmp)
        cfg = load_config(path)
        issues = _validate_config(cfg)
        assert any("model_name" in i for i in issues)


def test_check_dirs_missing_model(tmp_path):
    """When check_dirs=True, missing model files should be flagged."""
    raw = {**_VALID_CONFIG}
    with tempfile.TemporaryDirectory() as tmp:
        path = _write_config(raw, tmp)
        cfg = load_config(path)
        issues = _validate_config(cfg, check_dirs=True)
        # Model files don't exist → should flag each server
        assert len([i for i in issues if "model file not found" in i]) == len(cfg.llm_servers)


def test_profile_generation_defaults():
    """ProfileConfig must provide default repetition penalty parameters."""
    from app.config import ProfileConfig

    profile = ProfileConfig()
    assert "frequency_penalty" in profile.generation_defaults
    assert "presence_penalty" in profile.generation_defaults
    assert profile.generation_defaults["frequency_penalty"] > 0
    assert profile.generation_defaults["presence_penalty"] > 0


def test_profile_generation_defaults_overridable():
    """User-supplied generation_defaults in config.yaml must override built-in defaults."""
    from app.config import ProfileConfig

    profile = ProfileConfig(generation_defaults={"frequency_penalty": 1.2})
    assert profile.generation_defaults["frequency_penalty"] == 1.2
    # When user overrides completely, the other defaults aren't injected
    assert "presence_penalty" not in profile.generation_defaults
