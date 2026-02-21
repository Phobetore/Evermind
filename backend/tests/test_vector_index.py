"""Tests for the vector index module."""

from __future__ import annotations

import os
import tempfile

import pytest

from app.core.vector_index import VectorIndex


@pytest.fixture
def tmp_index_path() -> str:
    """Return a temporary file path for a vector index."""
    fd, path = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    os.unlink(path)  # start with no file
    return path


def test_add_and_search(tmp_index_path: str) -> None:
    """Adding vectors and searching should return nearest neighbours."""
    idx = VectorIndex(dimension=4, index_path=tmp_index_path)
    idx.add("a", [1.0, 0.0, 0.0, 0.0])
    idx.add("b", [0.0, 1.0, 0.0, 0.0])
    idx.add("c", [0.9, 0.1, 0.0, 0.0])

    results = idx.search([1.0, 0.0, 0.0, 0.0], top_k=2)
    assert len(results) == 2
    # "a" should be the closest, then "c"
    assert results[0][0] == "a"
    assert results[1][0] == "c"
    assert results[0][1] > results[1][1]  # similarity order


def test_remove(tmp_index_path: str) -> None:
    """Removing a vector should exclude it from search."""
    idx = VectorIndex(dimension=3, index_path=tmp_index_path)
    idx.add("x", [1.0, 0.0, 0.0])
    idx.add("y", [0.0, 1.0, 0.0])
    assert len(idx) == 2

    idx.remove("x")
    assert len(idx) == 1
    results = idx.search([1.0, 0.0, 0.0], top_k=5)
    ids = [r[0] for r in results]
    assert "x" not in ids


def test_save_and_load(tmp_index_path: str) -> None:
    """Index should survive a save → load cycle."""
    idx = VectorIndex(dimension=3, index_path=tmp_index_path)
    idx.add("m1", [0.1, 0.2, 0.3])
    idx.add("m2", [0.4, 0.5, 0.6])
    idx.save()

    idx2 = VectorIndex(dimension=3, index_path=tmp_index_path)
    assert len(idx2) == 2
    results = idx2.search([0.1, 0.2, 0.3], top_k=1)
    assert results[0][0] == "m1"


def test_rebuild(tmp_index_path: str) -> None:
    """Rebuild should replace the entire index."""
    idx = VectorIndex(dimension=2, index_path=tmp_index_path)
    idx.add("old", [1.0, 0.0])
    assert len(idx) == 1

    idx.rebuild([("new1", [0.5, 0.5]), ("new2", [0.0, 1.0])])
    assert len(idx) == 2
    ids = [r[0] for r in idx.search([0.5, 0.5], top_k=5)]
    assert "old" not in ids
    assert "new1" in ids


def test_filter_ids(tmp_index_path: str) -> None:
    """Search with filter_ids should restrict results."""
    idx = VectorIndex(dimension=3, index_path=tmp_index_path)
    idx.add("a", [1.0, 0.0, 0.0])
    idx.add("b", [0.9, 0.1, 0.0])
    idx.add("c", [0.0, 0.0, 1.0])

    results = idx.search([1.0, 0.0, 0.0], top_k=5, filter_ids={"b", "c"})
    ids = [r[0] for r in results]
    assert "a" not in ids
    assert "b" in ids


def test_empty_search(tmp_index_path: str) -> None:
    """Searching an empty index should return an empty list."""
    idx = VectorIndex(dimension=3, index_path=tmp_index_path)
    results = idx.search([1.0, 0.0, 0.0], top_k=5)
    assert results == []


def test_add_replaces_existing(tmp_index_path: str) -> None:
    """Adding a vector with an existing id should update in place."""
    idx = VectorIndex(dimension=2, index_path=tmp_index_path)
    idx.add("m1", [1.0, 0.0])
    idx.add("m1", [0.0, 1.0])
    assert len(idx) == 1
    results = idx.search([0.0, 1.0], top_k=1)
    assert results[0][0] == "m1"
    assert results[0][1] > 0.99  # should be very close to 1.0


def test_bad_dimension_raises(tmp_index_path: str) -> None:
    """Adding an embedding of wrong dimension should raise ValueError."""
    idx = VectorIndex(dimension=3, index_path=tmp_index_path)
    with pytest.raises(ValueError, match="dimension"):
        idx.add("bad", [1.0, 0.0])
