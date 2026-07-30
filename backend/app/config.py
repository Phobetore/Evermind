"""Runtime configuration resolved from environment variables."""

import os
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def data_dir() -> Path:
    d = Path(os.environ.get("EVERMIND_DATA_DIR", _REPO_ROOT / "data"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return data_dir() / "evermind.db"


def media_dir() -> Path:
    d = data_dir() / "media"
    d.mkdir(parents=True, exist_ok=True)
    return d


def library_dir() -> Path:
    """Starter cards shipped with the repo (read-only)."""
    return Path(os.environ.get("EVERMIND_LIBRARY_DIR", _REPO_ROOT / "library"))
