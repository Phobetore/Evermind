"""Tolerant JSON parsing for LLM replies.

Roleplay-tuned models rarely emit strict JSON: they wrap it in markdown
fences, chat around it, leave trailing commas, and above all write literal
newlines inside string values. This module repairs those failure modes.
"""

import json
import re

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)
_TRAILING_COMMA_RE = re.compile(r",\s*([}\]])")


def parse_llm_json(text: str) -> dict | None:
    """Best-effort extraction of one JSON object; None if hopeless."""
    if not text:
        return None
    candidates = [text]
    fence = _FENCE_RE.search(text)
    if fence:
        candidates.append(fence.group(1))
    start = text.find("{")
    if start > 0:
        candidates.append(text[start:])
    for candidate in candidates:
        for attempt in (candidate, _repair(candidate)):
            obj = _try_decode(attempt)
            if obj is not None:
                return obj
    return None


def _try_decode(text: str) -> dict | None:
    text = text.strip()
    if not text:
        return None
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except ValueError:
        pass
    start = text.find("{")
    if start == -1:
        return None
    try:
        # raw_decode reads one complete object and ignores trailing chatter
        obj, _ = json.JSONDecoder().raw_decode(text[start:])
        return obj if isinstance(obj, dict) else None
    except ValueError:
        return None


def _repair(text: str) -> str:
    """Escape literal control characters inside strings, drop trailing commas."""
    out: list[str] = []
    in_string = False
    escaped = False
    for ch in text:
        if in_string:
            if escaped:
                escaped = False
                out.append(ch)
            elif ch == "\\":
                escaped = True
                out.append(ch)
            elif ch == '"':
                in_string = False
                out.append(ch)
            elif ch == "\n":
                out.append("\\n")
            elif ch == "\r":
                out.append("\\r")
            elif ch == "\t":
                out.append("\\t")
            else:
                out.append(ch)
        else:
            if ch == '"':
                in_string = True
            out.append(ch)
    return _TRAILING_COMMA_RE.sub(r"\1", "".join(out))
