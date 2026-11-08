"""Tolerant JSON parsing for LLM replies.

Roleplay-tuned models rarely emit strict JSON: they wrap it in markdown
fences, chat around it, leave trailing commas, and above all write literal
newlines inside string values. This module repairs those failure modes.
"""

import json
import re

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)
_CLOSER_RE = re.compile(r"\s*[}\]]")


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
    # A RecursionError is no ValueError: a reply nested past what the decoder
    # follows is one that cannot be read, not a turn that ends.
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except (ValueError, RecursionError):
        pass
    start = text.find("{")
    if start == -1:
        return None
    try:
        # raw_decode reads one complete object and ignores trailing chatter
        obj, _ = json.JSONDecoder().raw_decode(text[start:])
        return obj if isinstance(obj, dict) else None
    except (ValueError, RecursionError):
        return None


def _repair(text: str) -> str:
    """Escape literal control characters inside strings, drop trailing commas outside them."""
    out: list[str] = []
    in_string = False
    escaped = False
    for i, ch in enumerate(text):
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
        elif ch != "," or not _CLOSER_RE.match(text, i + 1):
            in_string = ch == '"'
            out.append(ch)
    return "".join(out)
