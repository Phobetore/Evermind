"""Card macro substitution: {{char}}, {{user}}, {{original}} (case-insensitive), and, for the
rules of community cards, the rest of a card's markers (expand_macros)."""

import re

_CHAR_RE = re.compile(r"\{\{\s*char\s*\}\}", re.IGNORECASE)
_USER_RE = re.compile(r"\{\{\s*user\s*\}\}", re.IGNORECASE)
_ORIGINAL_RE = re.compile(r"\{\{\s*original\s*\}\}", re.IGNORECASE)

# A marker's body never holds a brace ([^{}]*, not a lazy match of anything): an unclosed one
# then ends at the next brace, where it would otherwise scan to the end of the text for each
# possible start. A roll's separator, "::", ":" or a space, is written so that a run of spaces
# can be read one way only: "\s*(?:::|:|\s)\s*" is the same text, but tries every split of the run.
# A roll's \d takes any script's digits, as Python's Unicode knows them: the TypeScript engine
# lists those of Python 3.12 and later, and on 3.11 Kawi's and Nag Mundari's are not digits yet.
_COMMENT_RE = re.compile(r"\{\{\s*//[^{}]*\}\}")
_MARKER_RE = re.compile(
    r"\{\{\s*(?:(random|pick)\s*(::|:)([^{}]*)|roll(?:\s*::?\s*|\s+)(?:1?d)?(\d{1,9})\s*)\}\}",
    re.IGNORECASE)
_UNESCAPED_COMMA_RE = re.compile(r"(?<!\\),")
# The first format's names, in one pass so that a name holding one of them is left as it is.
_NAME_TAG_RE = re.compile(r"<(?:(user)|bot|char)>", re.IGNORECASE)
_LONE_SURROGATE_RE = re.compile("[\ud800-\udfff]")

_FNV_OFFSET = 0x811C9DC5
_FNV_PRIME = 0x01000193


def substitute(text: str, char_name: str, user_name: str) -> str:
    if not text:
        return ""
    # A function, not the name itself: re reads a replacement string for
    # escapes such as \1 and \d, and a name may contain them.
    text = _CHAR_RE.sub(lambda _: char_name, text)
    return _USER_RE.sub(lambda _: user_name, text)


def substitute_original(text: str, original: str) -> str:
    if not text:
        return ""
    return _ORIGINAL_RE.sub(lambda _: original, text)


def has_original_macro(text: str) -> bool:
    return bool(text and _ORIGINAL_RE.search(text))


def _fnv1a_bytes(data: bytes, h: int = _FNV_OFFSET) -> int:
    for byte in data:
        h = ((h ^ byte) * _FNV_PRIME) & 0xFFFFFFFF
    return h


def _utf8(text: str) -> bytes:
    # Half of a surrogate cannot be written in UTF-8: it is hashed as the replacement character,
    # as a browser's TextEncoder writes it.
    return _LONE_SURROGATE_RE.sub("\ufffd", text).encode("utf-8")


def fnv1a(text: str) -> int:
    """FNV-1a on 32 bits of the text's UTF-8: the chance of a card's markers, fixed so that the
    same text draws the same in both engines and in every turn."""
    return _fnv1a_bytes(_utf8(text))


def expand_macros(text: str, char_name: str, user_name: str, seed: str) -> str:
    """A card's markers in one text, for the card rules: comments out, choices made, names in."""
    if not text:
        return ""
    # The hash of what comes before each marker's rank is the same for every marker: found once,
    # and only when there is one, so that a long text is not hashed again for each.
    prefix: list[int] = []

    def draw(rank: int) -> int:
        if not prefix:
            prefix.append(_fnv1a_bytes(_utf8(f"{seed}\0{text}\0")))
        return _fnv1a_bytes(str(rank).encode("ascii"), prefix[0])

    rank = -1

    def choose(match: re.Match) -> str:
        nonlocal rank
        rank += 1
        h = draw(rank)
        if match.group(1) is not None:
            body = match.group(3)
            parts = body.split("::") if match.group(2) == "::" else _UNESCAPED_COMMA_RE.split(body)
            choices = [part.replace("\\,", ",").strip() for part in parts]
            return choices[h % len(choices)] if choices else ""
        sides = int(match.group(4))
        return str(1 + h % sides) if sides else match.group(0)

    expanded = _COMMENT_RE.sub("", text)
    expanded = _MARKER_RE.sub(choose, expanded)
    expanded = _NAME_TAG_RE.sub(lambda m: user_name if m.group(1) else char_name, expanded)
    return substitute(expanded, char_name=char_name, user_name=user_name)
