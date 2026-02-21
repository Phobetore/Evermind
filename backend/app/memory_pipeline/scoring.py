"""Memory priority scoring — computes a composite score for retrieval ranking.

Implements the formula from the AI & Memory roadmap §6.2:

    priority = w_sim × similarity
             + w_imp × (importance × confidence)
             + w_rec × recency_factor
             + w_ref × referenced_factor
             - w_del × is_deleted
             + pin_bonus  (if pinned)

Where:
    recency_factor   = exp(-age_days / tau)
    referenced_factor = exp(-ref_days / tau_ref)
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.models.memory import MemoryResponse


@dataclass(frozen=True, slots=True)
class ScoringWeights:
    """Tunable weights for the priority formula."""

    w_sim: float = 0.35
    w_imp: float = 0.25
    w_rec: float = 0.20
    w_ref: float = 0.15
    w_del: float = 10.0
    tau: float = 30.0  # recency decay half-life in days
    tau_ref: float = 14.0  # referenced decay half-life in days
    pin_bonus: float = 5.0


# Module-level default weights.
DEFAULT_WEIGHTS = ScoringWeights()


def _days_since(iso_timestamp: str | None, now: datetime | None = None) -> float:
    """Return fractional days between *iso_timestamp* and *now*."""
    if iso_timestamp is None:
        return 365.0  # treat missing timestamps as very old
    ref = datetime.fromisoformat(iso_timestamp)
    if ref.tzinfo is None:
        ref = ref.replace(tzinfo=UTC)
    current = now or datetime.now(UTC)
    delta = (current - ref).total_seconds()
    return max(delta / 86_400.0, 0.0)


def recency_factor(created_at: str | None, tau: float, *, now: datetime | None = None) -> float:
    """Exponential recency decay: ``exp(-age_days / tau)``."""
    age = _days_since(created_at, now)
    return math.exp(-age / tau) if tau > 0 else 0.0


def referenced_factor(
    last_referenced_at: str | None,
    created_at: str | None,
    tau_ref: float,
    *,
    now: datetime | None = None,
) -> float:
    """Exponential referenced-recency decay.

    Falls back to *created_at* if the memory was never referenced.
    """
    ts = last_referenced_at or created_at
    age = _days_since(ts, now)
    return math.exp(-age / tau_ref) if tau_ref > 0 else 0.0


def compute_priority(
    memory: MemoryResponse,
    similarity: float = 0.0,
    weights: ScoringWeights = DEFAULT_WEIGHTS,
    *,
    now: datetime | None = None,
) -> float:
    """Return the composite priority score for a single memory."""
    importance_adj = memory.importance * memory.confidence

    rec = recency_factor(memory.created_at, weights.tau, now=now)
    ref = referenced_factor(
        memory.last_referenced_at, memory.created_at, weights.tau_ref, now=now
    )

    priority = (
        weights.w_sim * similarity
        + weights.w_imp * importance_adj
        + weights.w_rec * rec
        + weights.w_ref * ref
        - weights.w_del * (1.0 if memory.is_deleted else 0.0)
    )

    if memory.is_pinned:
        priority += weights.pin_bonus

    return priority
