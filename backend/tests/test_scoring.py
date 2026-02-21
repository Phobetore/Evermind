"""Tests for the memory scoring module."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

import pytest

from app.memory_pipeline.scoring import (
    DEFAULT_WEIGHTS,
    compute_priority,
    recency_factor,
    referenced_factor,
)
from app.models.memory import MemoryResponse


def _make_memory(
    *,
    importance: float = 0.5,
    confidence: float = 0.8,
    is_pinned: bool = False,
    is_deleted: bool = False,
    created_at: str | None = None,
    last_referenced_at: str | None = None,
) -> MemoryResponse:
    now = datetime.now(UTC)
    return MemoryResponse(
        id="test-mem-1",
        character_id="char-1",
        type="semantic",
        title="Test",
        content="Test content",
        entities=[],
        tags=[],
        importance=importance,
        confidence=confidence,
        is_pinned=is_pinned,
        is_deleted=is_deleted,
        created_at=created_at or now.isoformat(),
        last_referenced_at=last_referenced_at,
        source_turn_id=None,
    )


def test_recency_factor_recent() -> None:
    """A memory created just now should have recency ≈ 1.0."""
    now = datetime.now(UTC)
    factor = recency_factor(now.isoformat(), tau=30.0, now=now)
    assert factor == pytest.approx(1.0, abs=0.01)


def test_recency_factor_old() -> None:
    """A memory created 30 days ago with tau=30 should have recency ≈ 1/e."""
    now = datetime.now(UTC)
    old = (now - timedelta(days=30)).isoformat()
    factor = recency_factor(old, tau=30.0, now=now)
    assert factor == pytest.approx(math.exp(-1), abs=0.01)


def test_recency_factor_none_timestamp() -> None:
    """Missing timestamp should produce very low recency."""
    factor = recency_factor(None, tau=30.0)
    assert factor < 0.001


def test_referenced_factor_never_referenced() -> None:
    """Falls back to created_at if never referenced."""
    now = datetime.now(UTC)
    created = now.isoformat()
    factor = referenced_factor(None, created, tau_ref=14.0, now=now)
    assert factor == pytest.approx(1.0, abs=0.01)


def test_compute_priority_basic() -> None:
    """Basic scoring should return a positive float."""
    mem = _make_memory()
    score = compute_priority(mem, similarity=0.8)
    assert isinstance(score, float)
    assert score > 0


def test_compute_priority_pinned_bonus() -> None:
    """Pinned memory should score higher than unpinned (all else equal)."""
    base = _make_memory(is_pinned=False)
    pinned = _make_memory(is_pinned=True)
    s_base = compute_priority(base, similarity=0.5)
    s_pinned = compute_priority(pinned, similarity=0.5)
    assert s_pinned > s_base


def test_compute_priority_deleted_penalty() -> None:
    """Deleted memory should score much lower."""
    active = _make_memory(is_deleted=False)
    deleted = _make_memory(is_deleted=True)
    s_active = compute_priority(active, similarity=0.5)
    s_deleted = compute_priority(deleted, similarity=0.5)
    assert s_active > s_deleted


def test_compute_priority_high_similarity_wins() -> None:
    """Higher similarity should lead to higher priority."""
    mem = _make_memory()
    s_low = compute_priority(mem, similarity=0.1)
    s_high = compute_priority(mem, similarity=0.9)
    assert s_high > s_low


def test_scoring_weights_defaults() -> None:
    """Default weights should be valid."""
    w = DEFAULT_WEIGHTS
    assert w.w_sim == 0.35
    assert w.w_imp == 0.25
    assert w.tau > 0
