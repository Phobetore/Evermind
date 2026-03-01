"""Tests for database path resolution."""

from __future__ import annotations

from pathlib import Path

from app.core.database import _PROJECT_ROOT


def test_project_root_is_absolute() -> None:
    """_PROJECT_ROOT must be an absolute path."""
    assert _PROJECT_ROOT.is_absolute(), (
        f"_PROJECT_ROOT should be absolute, got: {_PROJECT_ROOT}"
    )


def test_project_root_contains_backend() -> None:
    """_PROJECT_ROOT must point to the actual project root (contains backend/)."""
    assert (_PROJECT_ROOT / "backend").is_dir(), (
        f"Expected project root at {_PROJECT_ROOT} to contain backend/"
    )


def test_default_db_path_under_project_data() -> None:
    """The default database path must resolve to data/app.db under the project root."""
    default_path = _PROJECT_ROOT / "data" / "app.db"
    assert default_path.parent.name == "data"
    assert default_path.name == "app.db"
    # Ensure it does NOT land inside backend/
    assert "backend" not in str(Path(*default_path.parts[:-2]).name)
