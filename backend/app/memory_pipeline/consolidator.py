"""Memory consolidator — deduplication, merging, and reference updates.

After new memories are extracted they pass through consolidation which:
  1. Checks for near-duplicates (cosine similarity > threshold).
  2. Merges duplicates (content combined, confidence bumped).
  3. Updates ``last_referenced_at`` for recalled memories.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from app.core.repositories.memory_repository import MemoryRepository

if TYPE_CHECKING:
    from app.core.vector_index import VectorIndex
    from app.models.memory import MemoryResponse

logger = logging.getLogger(__name__)

# Default deduplication threshold.
DEDUP_SIMILARITY_THRESHOLD = 0.90


async def deduplicate_memory(
    new_memory: MemoryResponse,
    character_id: str,
    new_embedding: list[float],
    *,
    vector_index: VectorIndex | None = None,
    mem_repo: MemoryRepository | None = None,
    threshold: float = DEDUP_SIMILARITY_THRESHOLD,
) -> MemoryResponse:
    """Check if *new_memory* is a near-duplicate and merge if so.

    Returns the (possibly merged) memory.  If no duplicate is found
    the original memory is returned unchanged.
    """
    repo = mem_repo or MemoryRepository()

    if vector_index is None or not new_embedding:
        return new_memory

    # Search for similar existing memories
    existing = await repo.list_by_character(character_id, include_deleted=False)
    existing_ids = {m.id for m in existing if m.id != new_memory.id}

    if not existing_ids:
        return new_memory

    results = vector_index.search(
        new_embedding, top_k=5, filter_ids=existing_ids
    )

    for candidate_id, similarity in results:
        if similarity < threshold:
            continue

        # Found a duplicate — merge new into existing
        logger.info(
            "Deduplicating memory %s into %s (similarity=%.3f)",
            new_memory.id,
            candidate_id,
            similarity,
        )
        merged_content = f"{new_memory.content} | {new_memory.title}"
        merged = await repo.merge(
            source_id=new_memory.id,
            target_id=candidate_id,
            merged_content=merged_content,
        )
        if merged is not None:
            return merged

    return new_memory


async def consolidate_memories(
    character_id: str,
    *,
    vector_index: VectorIndex | None = None,
    mem_repo: MemoryRepository | None = None,
    threshold: float = DEDUP_SIMILARITY_THRESHOLD,
) -> int:
    """Run a full deduplication pass over all active memories for a character.

    Returns the number of memories merged (removed).
    """
    repo = mem_repo or MemoryRepository()
    memories = await repo.list_by_character(character_id, include_deleted=False)

    if vector_index is None or len(memories) < 2:
        return 0

    merged_count = 0
    processed_ids: set[str] = set()

    for mem in memories:
        if mem.id in processed_ids:
            continue
        processed_ids.add(mem.id)

        # Search for near-duplicates of this memory
        active_ids = {
            m.id for m in memories if m.id != mem.id and m.id not in processed_ids
        }
        if not active_ids:
            continue

        # We need the embedding from the vector index
        embedding = vector_index.get_embedding(mem.id)
        if embedding is None:
            continue

        results = vector_index.search(embedding, top_k=5, filter_ids=active_ids)

        for candidate_id, similarity in results:
            if similarity < threshold:
                continue
            if candidate_id in processed_ids:
                continue

            logger.info(
                "Consolidation: merging %s into %s (similarity=%.3f)",
                candidate_id,
                mem.id,
                similarity,
            )
            merged_content = f"{mem.content}"
            candidate = await repo.get(candidate_id)
            if candidate:
                merged_content = f"{mem.content} | {candidate.content}"

            await repo.merge(
                source_id=candidate_id,
                target_id=mem.id,
                merged_content=merged_content,
            )
            processed_ids.add(candidate_id)
            vector_index.remove(candidate_id)
            merged_count += 1

    if merged_count > 0:
        vector_index.save()
        logger.info(
            "Consolidation complete for character %s: %d memories merged",
            character_id,
            merged_count,
        )

    return merged_count
