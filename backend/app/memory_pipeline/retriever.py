"""Memory retriever — searches, scores, and selects relevant memories for prompt injection.

Pipeline:
  1. Build a query from the user message
  2. Search vector index for top-K candidates
  3. Apply priority scoring
  4. Select top-N and return
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from app.core.repositories.memory_repository import MemoryRepository
from app.memory_pipeline.scoring import ScoringWeights, compute_priority

if TYPE_CHECKING:
    from app.core.vector_index import VectorIndex
    from app.models.memory import MemoryResponse

logger = logging.getLogger(__name__)

# Default retrieval parameters.
DEFAULT_TOP_K = 30  # vector search candidates
DEFAULT_TOP_N = 10  # memories injected into prompt


async def retrieve_relevant_memories(
    character_id: str,
    query_embedding: list[float],
    *,
    vector_index: VectorIndex | None = None,
    mem_repo: MemoryRepository | None = None,
    top_k: int = DEFAULT_TOP_K,
    top_n: int = DEFAULT_TOP_N,
    weights: ScoringWeights | None = None,
    include_pinned: bool = True,
) -> list[MemoryResponse]:
    """Return the *top_n* most relevant memories for prompt injection.

    Steps:
      1. Search vector index for *top_k* similar memories.
      2. Load full memory rows from the DB.
      3. Score each memory with :func:`compute_priority`.
      4. Always include pinned memories (sorted by importance).
      5. Return the top-*top_n* memories.
    """
    repo = mem_repo or MemoryRepository()
    w = weights or ScoringWeights()

    # Similarity map: memory_id → cosine similarity
    sim_map: dict[str, float] = {}

    if vector_index is not None and query_embedding:
        # Fetch IDs of all active memories for this character
        all_memories = await repo.list_by_character(character_id, include_deleted=False)
        active_ids = {m.id for m in all_memories}
        search_results = vector_index.search(query_embedding, top_k=top_k, filter_ids=active_ids)
        sim_map = dict(search_results)

    # Load candidate memories (all non-deleted for this character)
    candidates = await repo.list_by_character(character_id, include_deleted=False)

    # Score each candidate
    scored: list[tuple[MemoryResponse, float]] = []
    for mem in candidates:
        sim = sim_map.get(mem.id, 0.0)
        score = compute_priority(mem, similarity=sim, weights=w)
        scored.append((mem, score))

    # Sort by score descending
    scored.sort(key=lambda x: x[1], reverse=True)

    # Build the final selection
    selected: list[MemoryResponse] = []
    selected_ids: set[str] = set()
    pinned: list[MemoryResponse] = []

    # Always include pinned memories first
    if include_pinned:
        pinned = await repo.get_pinned(character_id)
        for pm in pinned:
            if pm.id not in selected_ids:
                selected.append(pm)
                selected_ids.add(pm.id)

    # Fill remaining slots from scored list
    for mem, _score in scored:
        if len(selected) >= top_n:
            break
        if mem.id not in selected_ids:
            selected.append(mem)
            selected_ids.add(mem.id)

    # Update last_referenced_at for selected memories
    for mem in selected:
        await repo.update_referenced_at(mem.id)

    logger.debug(
        "Retrieved %d memories for character %s (from %d candidates, %d pinned)",
        len(selected),
        character_id,
        len(candidates),
        len(selected_ids & {m.id for m in (pinned if include_pinned else [])}),
    )

    return selected
