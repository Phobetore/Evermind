"""Tests for database path resolution."""

from __future__ import annotations

import os
from pathlib import Path


def test_default_database_path_is_absolute() -> None:
    """DATABASE_PATH default must be absolute so it never depends on the CWD."""
    saved = os.environ.pop("DATABASE_PATH", None)
    try:
        import importlib

        import app.core.database as db_mod

        importlib.reload(db_mod)
        assert os.path.isabs(db_mod.DATABASE_PATH), (
            f"Default DATABASE_PATH should be absolute, got: {db_mod.DATABASE_PATH}"
        )
    finally:
        if saved is not None:
            os.environ["DATABASE_PATH"] = saved


def test_default_database_path_under_project_root() -> None:
    """DATABASE_PATH default must point to data/app.db under the project root."""
    saved = os.environ.pop("DATABASE_PATH", None)
    try:
        import importlib

        import app.core.database as db_mod

        importlib.reload(db_mod)
        db_path = Path(db_mod.DATABASE_PATH)
        # The project root contains the backend/ directory
        project_root = db_path.parent.parent
        assert (project_root / "backend").is_dir(), (
            f"Expected project root at {project_root} to contain backend/"
        )
        assert db_path.name == "app.db"
        assert db_path.parent.name == "data"
    finally:
        if saved is not None:
            os.environ["DATABASE_PATH"] = saved
