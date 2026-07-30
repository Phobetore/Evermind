"""Card macro substitution: {{char}}, {{user}}, {{original}} (case-insensitive)."""

import re

_CHAR_RE = re.compile(r"\{\{\s*char\s*\}\}", re.IGNORECASE)
_USER_RE = re.compile(r"\{\{\s*user\s*\}\}", re.IGNORECASE)
_ORIGINAL_RE = re.compile(r"\{\{\s*original\s*\}\}", re.IGNORECASE)


def substitute(text: str, char_name: str, user_name: str) -> str:
    if not text:
        return ""
    text = _CHAR_RE.sub(char_name, text)
    return _USER_RE.sub(user_name, text)


def substitute_original(text: str, original: str) -> str:
    if not text:
        return ""
    return _ORIGINAL_RE.sub(lambda _: original, text)


def has_original_macro(text: str) -> bool:
    return bool(text and _ORIGINAL_RE.search(text))
