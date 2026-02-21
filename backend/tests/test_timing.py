"""Tests for TimingContext."""

from __future__ import annotations

import time

from app.services.timing import TimingContext


def test_timing_context_basic() -> None:
    ctx = TimingContext()
    time.sleep(0.01)  # 10ms
    ctx.mark("t_stream_end")
    ctx.mark("t_request_end")
    meta = ctx.to_meta()
    assert meta["dur_total"] > 0
    assert meta["dur_generate"] > 0
    assert isinstance(meta["t_request_start"], int)


def test_timing_context_missing_markers() -> None:
    ctx = TimingContext()
    ctx.mark("t_request_end")
    meta = ctx.to_meta()
    # Judge was never marked, should be 0
    assert meta["dur_judge"] == 0.0
    assert meta["dur_self_refine"] == 0.0
