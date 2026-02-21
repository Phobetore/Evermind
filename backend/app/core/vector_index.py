"""Lightweight numpy-based vector index for memory retrieval.

This is the v0.2 baseline implementation that uses brute-force cosine
similarity.  It is suitable for < 50 000 vectors and will be replaced
by hnswlib / faiss in a later iteration if performance requires it.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Compute cosine similarity between vector *a* and matrix *b* (row-wise)."""
    if b.size == 0:
        return np.array([], dtype=np.float64)
    a_norm = a / (np.linalg.norm(a) + 1e-10)
    b_norm = b / (np.linalg.norm(b, axis=1, keepdims=True) + 1e-10)
    return b_norm @ a_norm


class VectorIndex:
    """In-memory vector index backed by a JSON file on disk.

    Parameters
    ----------
    dimension:
        Dimensionality of the embeddings (e.g. 384 for E5-small-v2).
    index_path:
        Path to persist the index as a JSON mapping of
        ``{memory_id: [float, …]}``.
    """

    def __init__(self, dimension: int, index_path: str = "data/vectors/memories.json") -> None:
        self.dimension = dimension
        self.index_path = index_path
        self._ids: list[str] = []
        self._vectors: np.ndarray = np.empty((0, dimension), dtype=np.float64)
        self.load()

    # --- Mutators --------------------------------------------------------

    def add(self, memory_id: str, embedding: list[float]) -> None:
        """Add or replace a vector for *memory_id*."""
        vec = np.asarray(embedding, dtype=np.float64)
        if vec.shape != (self.dimension,):
            raise ValueError(
                f"Expected embedding of dimension {self.dimension}, got {vec.shape}"
            )
        # Replace if exists
        if memory_id in self._ids:
            idx = self._ids.index(memory_id)
            self._vectors[idx] = vec
        else:
            self._ids.append(memory_id)
            self._vectors = np.vstack([self._vectors, vec.reshape(1, -1)])

    def remove(self, memory_id: str) -> None:
        """Remove the vector for *memory_id* (no-op if absent)."""
        if memory_id not in self._ids:
            return
        idx = self._ids.index(memory_id)
        self._ids.pop(idx)
        self._vectors = np.delete(self._vectors, idx, axis=0)

    def rebuild(self, memories: list[tuple[str, list[float]]]) -> None:
        """Rebuild the entire index from a list of ``(memory_id, embedding)``."""
        self._ids = [m[0] for m in memories]
        if memories:
            self._vectors = np.array([m[1] for m in memories], dtype=np.float64)
        else:
            self._vectors = np.empty((0, self.dimension), dtype=np.float64)

    # --- Search ----------------------------------------------------------

    def search(
        self,
        query_embedding: list[float],
        top_k: int = 30,
        filter_ids: set[str] | None = None,
    ) -> list[tuple[str, float]]:
        """Return the *top_k* most similar ``(memory_id, similarity)`` pairs.

        If *filter_ids* is given, restrict the search to those IDs.
        """
        if not self._ids:
            return []

        query = np.asarray(query_embedding, dtype=np.float64)
        sims = _cosine_similarity(query, self._vectors)

        # Apply filter mask
        if filter_ids is not None:
            mask = np.array([mid in filter_ids for mid in self._ids], dtype=bool)
            sims = np.where(mask, sims, -2.0)

        k = min(top_k, len(self._ids))
        top_indices = np.argpartition(-sims, k)[:k]
        top_indices = top_indices[np.argsort(-sims[top_indices])]

        return [(self._ids[i], float(sims[i])) for i in top_indices if sims[i] > -1.0]

    # --- Persistence -----------------------------------------------------

    def save(self) -> None:
        """Persist the index to disk as JSON."""
        os.makedirs(os.path.dirname(self.index_path) or ".", exist_ok=True)
        data: dict[str, Any] = {}
        for mid, vec in zip(self._ids, self._vectors, strict=True):
            data[mid] = vec.tolist()
        with open(self.index_path, "w") as f:
            json.dump(data, f)
        logger.debug("Vector index saved (%d entries) → %s", len(self._ids), self.index_path)

    def load(self) -> None:
        """Load the index from disk (if the file exists)."""
        path = Path(self.index_path)
        if not path.is_file():
            logger.debug("No vector index file at %s — starting empty", self.index_path)
            return
        try:
            with open(path) as f:
                data: dict[str, list[float]] = json.load(f)
            self._ids = list(data.keys())
            if self._ids:
                self._vectors = np.array(list(data.values()), dtype=np.float64)
            else:
                self._vectors = np.empty((0, self.dimension), dtype=np.float64)
            logger.debug("Vector index loaded (%d entries) ← %s", len(self._ids), self.index_path)
        except (json.JSONDecodeError, ValueError):
            logger.warning("Corrupt vector index at %s — starting empty", self.index_path)
            self._ids = []
            self._vectors = np.empty((0, self.dimension), dtype=np.float64)

    def __len__(self) -> int:
        return len(self._ids)
