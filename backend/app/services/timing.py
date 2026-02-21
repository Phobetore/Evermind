"""TimingContext — latency measurement helper for the chat pipeline.

Follows Addendum v1.1 §E conventions.
"""

from __future__ import annotations

import time


class TimingContext:
    """Measures latencies across pipeline stages using ``perf_counter_ns``."""

    def __init__(self) -> None:
        self.t_request_start = time.perf_counter_ns()
        self._markers: dict[str, int] = {"t_request_start": self.t_request_start}

    def mark(self, name: str) -> None:
        """Record a named timestamp."""
        self._markers[name] = time.perf_counter_ns()

    def duration_ms(self, start: str, end: str) -> float:
        """Return the duration in milliseconds between two markers."""
        s = self._markers.get(start, 0)
        e = self._markers.get(end, 0)
        if s and e:
            return (e - s) / 1_000_000  # ns → ms
        return 0.0

    def to_meta(self) -> dict[str, float]:
        """Build the ``latency_ms`` section of the meta JSON."""
        return {
            "t_request_start": self._markers.get("t_request_start", 0),
            "t_first_token": self._markers.get("t_first_token", 0),
            "t_stream_end": self._markers.get("t_stream_end", 0),
            "t_request_end": self._markers.get("t_request_end", 0),
            "dur_total": self.duration_ms("t_request_start", "t_request_end"),
            "dur_generate": self.duration_ms("t_request_start", "t_stream_end"),
            "dur_judge": self.duration_ms("t_stream_end", "t_judge_end"),
            "dur_self_refine": self.duration_ms("t_judge_end", "t_self_refine_end"),
            "dur_memory_extract": self.duration_ms("t_stream_end", "t_memory_extract_end"),
            "dur_memory_write": self.duration_ms("t_memory_extract_end", "t_memory_write_end"),
        }
