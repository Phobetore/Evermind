"""Tolerant JSON parsing for LLM replies.

Roleplay-tuned models rarely emit strict JSON: they wrap it in markdown
fences, chat around it, leave trailing commas, and above all write literal
newlines inside string values. This module repairs those failure modes.
"""

import json
import re

from ..prompting.engine import strip_thought

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)
_CLOSER_RE = re.compile(r"\s*[}\]]")


def describe_answer(text: str) -> str:
    """How long an answer was and how it ended, for the log: the end tells an answer cut short in
    the middle of a sentence from one that is whole but malformed. Never the whole of it."""
    end = text[-80:].replace("\r", "").replace("\n", "\\n")
    return f"{len(text)} characters, ends with \"{end}\""


def parse_llm_json(text: str) -> dict | None:
    """Best-effort extraction of one JSON object; None if hopeless."""
    text = strip_thought(text)
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


def partial_json(text: str) -> tuple[dict, str | None]:
    """The top-level fields of an answer's object that are complete, and the name of the one being
    written where the text stops: an answer read while it arrives, or one cut short.

    A list still being written gives the elements it has finished, under its name, which is then
    the one being written. What parse_llm_json reads whole, this reads the same."""
    try:
        whole = parse_llm_json(text)
        if whole is not None:
            return whole, None
        return _read_partial(strip_thought(text))
    except (ValueError, RecursionError):
        # Each value is decoded on its own, and none may turn an answer that is only
        # unfinished into a failed request.
        return {}, None


_SPACE = " \t\r\n"
_LITERAL_END = ",}]" + _SPACE


def _skip_space(text: str, i: int) -> int:
    while i < len(text) and text[i] in _SPACE:
        i += 1
    return i


def _string_end(text: str, i: int) -> int | None:
    """Just past the string that opens at ``i``; None if the text stops inside it."""
    escaped = False
    for j in range(i + 1, len(text)):
        ch = text[j]
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == '"':
            return j + 1
    return None


def _value_end(text: str, i: int) -> int | None:
    """Just past the value that starts at ``i``; None if the text stops before it is whole.
    A number or a literal is whole only once something follows it: "12" may yet be "123"."""
    ch = text[i]
    if ch == '"':
        return _string_end(text, i)
    if ch in "{[":
        depth = 0
        j = i
        while j < len(text):
            ch = text[j]
            if ch == '"':
                end = _string_end(text, j)
                if end is None:
                    return None
                j = end
                continue
            if ch in "{[":
                depth += 1
            elif ch in "}]":
                depth -= 1
                if depth == 0:
                    return j + 1
            j += 1
        return None
    j = i
    while j < len(text) and text[j] not in _LITERAL_END:
        j += 1
    return j if j < len(text) else None


def _decode(token: str):
    return json.loads(_repair(token))


def _list_so_far(text: str, i: int) -> list:
    """The whole elements of the list that opens at ``i`` and that the text stops inside."""
    items: list = []
    i += 1
    while True:
        i = _skip_space(text, i)
        while i < len(text) and text[i] == ",":
            i = _skip_space(text, i + 1)
        if i >= len(text) or text[i] == "]":
            return items
        end = _value_end(text, i)
        if end is None:
            return items
        try:
            items.append(_decode(text[i:end]))
        except (ValueError, RecursionError):
            return items
        i = end


def _read_partial(text: str) -> tuple[dict, str | None]:
    fields: dict = {}
    i = text.find("{")
    if i == -1:
        return fields, None
    i += 1
    while True:
        i = _skip_space(text, i)
        while i < len(text) and text[i] == ",":
            i = _skip_space(text, i + 1)
        if i >= len(text) or text[i] != '"':
            return fields, None  # between two fields, at the end of the object, or lost
        key_end = _string_end(text, i)
        if key_end is None:
            return fields, None  # the name itself is not whole yet
        try:
            key = _decode(text[i:key_end])
        except ValueError:
            return fields, None
        i = _skip_space(text, key_end)
        if i >= len(text):
            return fields, key
        if text[i] != ":":
            return fields, None
        i = _skip_space(text, i + 1)
        if i >= len(text):
            return fields, key
        end = _value_end(text, i)
        if end is None:
            if text[i] == "[":
                fields[key] = _list_so_far(text, i)
            return fields, key
        try:
            fields[key] = _decode(text[i:end])
        except (ValueError, RecursionError):
            return fields, None
        i = end


def _try_decode(text: str) -> dict | None:
    text = text.strip()
    if not text:
        return None
    # A RecursionError is no ValueError: a reply nested past what the decoder
    # follows is one that cannot be read, not an error that escapes.
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
