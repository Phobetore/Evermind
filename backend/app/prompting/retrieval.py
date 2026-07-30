"""Rank established facts by semantic relevance to the current scene.

Pure comparison lives in `_cosine_scores`; `rank` wires it to the query
embedding. Returns None whenever embeddings are unavailable so callers fall
back to recency-based selection.
"""

import numpy as np

from . import embeddings
from .tokens import estimate_tokens


def _cosine_scores(query_vec, matrix) -> list[float]:
    """Cosine similarity of a query vector against each row of `matrix`.
    Vectors are L2-normalized upstream, so cosine reduces to a dot product."""
    if matrix.size == 0:
        return []
    q = np.asarray(query_vec, dtype=np.float32)
    return [float(x) for x in (matrix @ q)]


async def rank(query_text: str, embedding_map: dict[str, bytes]) -> dict[str, float] | None:
    """Map memory id -> relevance score for the current scene.
    `embedding_map` is {memory_id: blob}. Returns None if there is nothing to
    rank or the query cannot be embedded (caller falls back to recency)."""
    if not embedding_map or not query_text.strip():
        return None
    query = await embeddings.embed([query_text], kind="query")
    if not query:
        return None
    try:
        ids = list(embedding_map)
        matrix = np.vstack([embeddings.unpack(embedding_map[i]) for i in ids])
        scores = _cosine_scores(query[0], matrix)
        return {i: s for i, s in zip(ids, scores)}
    except Exception:  # corrupt/mismatched blob -> degrade to recency, never break the turn
        return None


def select_passages(ranked: dict[str, float], candidates: list[dict],
                    token_budget: int, exclude_positions: set | None = None) -> list[dict]:
    """Pick the most relevant past messages that fit `token_budget`, skipping any
    whose turn is already covered (exclude_positions). Highest score first for
    selection; returned oldest-first for chronological reading."""
    exclude = exclude_positions or set()
    scored = [c for c in candidates
              if c["id"] in ranked and c.get("position") not in exclude]
    scored.sort(key=lambda c: ranked[c["id"]], reverse=True)
    kept, budget = [], token_budget
    for c in scored:
        cost = estimate_tokens(c.get("content") or "")
        if cost > budget:
            continue
        budget -= cost
        kept.append(c)
    kept.sort(key=lambda c: c.get("position", 0))
    return kept
