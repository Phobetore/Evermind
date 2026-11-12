"""Which lorebook entries fire, on the rules of community cards: SillyTavern's, as its
cards are written for (keys on whole words, always-on entries, secondary keys, entries
that call one another). The matching is written out by hand rather than with regular
expressions, so that the TypeScript engine (frontend/src/engine/lorebook.ts) can follow
it step for step without depending on either language's dialect.
"""

import re

from .macros import substitute

# What makes a key several words, and so a plain substring.
SPACES = " \t\n\r\f\v                 　"

# The defaults of LoreEntryIn (models/schemas.py), for an entry that says nothing of a setting:
# the engine does not reach into the request models, so they are repeated here.
ENTRY_DEFAULTS = {
    "enabled": True,
    "constant": False,
    "selective": False,
    "secondary_keys": [],
    "selective_logic": 0,
    "insertion_order": 100,
    "position": 1,
    "depth": 4,
    "role": "system",
    "whole_words": True,
    "exclude_recursion": False,
    "prevent_recursion": False,
}

_OUTLET = 7  # shown only where a {{outlet}} macro asks for it, which Evermind does not have
_REGEX_KEY = re.compile(r"/([\s\S]+?)/([gimsuy]*)")
_WORD = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")


def _setting(entry: dict, name: str):
    return entry.get(name, ENTRY_DEFAULTS[name])


def _is_regex(key: str) -> bool:
    # SillyTavern reads such a key as a JavaScript regular expression; Evermind runs none.
    return _REGEX_KEY.fullmatch(key) is not None


def _is_substring(key: str, whole_words: bool) -> bool:
    return not whole_words or any(c in SPACES for c in key)


def _found(key: str, text: str, substring: bool, start: int = 0) -> bool:
    """Whether a key, trimmed and in lower case, is in the text from `start` on. Before
    `start` is text already looked at: no occurrence is counted there, and the character
    just before `start` is only ever read as the edge of a word."""
    index = text.find(key, start)
    if substring:
        return index != -1
    # Only ASCII letters, digits and _ make a word, as in SillyTavern: "ros" is a word in
    # "rosé", and a key in Japanese, with no spaces, is found anywhere in the text.
    while index != -1:
        end = index + len(key)
        before = text[index - 1] if index > 0 else ""
        after = text[end] if end < len(text) else ""
        if before not in _WORD and after not in _WORD:
            return True
        index = text.find(key, index + 1)
    return False


def key_matches(key: str, text: str, whole_words: bool) -> bool:
    """Whether a key is in a text already in lower case. Its {{char}} and {{user}} are put
    in by the caller, which knows the names."""
    key = key.strip().lower()
    return bool(key) and not _is_regex(key) and _found(key, text, _is_substring(key, whole_words))


def strip_decorators(content: str) -> str:
    """The content without the lines at its start that begin with @@ (CCv3 decorators, such
    as @@activate), nor the line breaks after them: they are for the engine, not the model."""
    while content.startswith("@@"):
        end = content.find("\n")
        content = "" if end == -1 else content[end:].lstrip("\n")
    return content


def _logic_holds(logic: int, seen: int, count: int) -> bool:
    if logic == 1:
        return seen < count     # not all of them
    if logic == 2:
        return seen == 0        # none of them
    if logic == 3:
        return seen == count    # all of them
    return seen > 0             # at least one


class _Candidate:
    """An entry that has not fired yet, and how many of its keys the text has shown so far."""

    def __init__(self, index: int, entry: dict, primary: list[str], secondary: list[str]):
        self.index, self.entry = index, entry
        self.constant = bool(_setting(entry, "constant"))
        self.exclude_recursion = bool(_setting(entry, "exclude_recursion"))
        self.logic = _setting(entry, "selective_logic")
        self.secondary_count = len(secondary)
        whole_words = bool(_setting(entry, "whole_words"))
        # The keys still to be seen. One of the form /.../ never is, so it is never looked for.
        self.primary = [(k, _is_substring(k, whole_words)) for k in primary if not _is_regex(k)]
        self.secondary = [(k, _is_substring(k, whole_words)) for k in secondary if not _is_regex(k)]
        self.seen_primary = 0
        self.seen_secondary = 0

    @staticmethod
    def _look(keys: list[tuple[str, bool]], text: str, added: str) -> list[tuple[str, bool]]:
        """The keys still not seen once `added` follows `text`."""
        unseen = []
        for key, substring in keys:
            tail = text[-(len(key) + 1):]
            # A tail shorter than the text starts on a character already looked at.
            if not _found(key, tail + added, substring, 1 if len(text) > len(tail) else 0):
                unseen.append((key, substring))
        return unseen

    def fires(self, text: str, added: str) -> bool:
        if self.primary:
            unseen = self._look(self.primary, text, added)
            self.seen_primary += len(self.primary) - len(unseen)
            self.primary = unseen
        if self.secondary:
            unseen = self._look(self.secondary, text, added)
            self.seen_secondary += len(self.secondary) - len(unseen)
            self.secondary = unseen
        return self.constant or (self.seen_primary > 0 and (
            self.secondary_count == 0
            or _logic_holds(self.logic, self.seen_secondary, self.secondary_count)))


def activated(entries: list[dict], scan: str, char_name: str, user_name: str) -> list[dict]:
    """The entries that fire on the text read, then on the contents of those that fired,
    until a pass adds nothing; in the lorebook's order.

    The answer is that of a full scan of the whole text at each pass. But the text only
    grows, so a key once there stays there: each entry keeps which of its keys were seen,
    and each pass only looks for the others in what the last pass added, with as much of
    the text before as the key is long, plus one, for a key across the join and the
    character before it. A chained lorebook of a thousand entries is not a thousand scans
    of the whole text: this runs in the server's event loop, and in a phone's tab."""
    def prepared(keys) -> list[str]:
        cleaned = (substitute(k, char_name=char_name, user_name=user_name).strip().lower()
                   for k in keys or [])
        return [k for k in cleaned if k]

    candidates = []
    for index, entry in enumerate(entries):
        if not _setting(entry, "enabled") or _setting(entry, "position") == _OUTLET:
            continue
        # Secondary keys count only on a selective entry, and only those left once trimmed.
        secondary = prepared(_setting(entry, "secondary_keys")) if _setting(entry, "selective") else []
        candidates.append(_Candidate(index, entry, prepared(entry.get("keys")), secondary))

    fired: list[_Candidate] = []
    # `text` is what earlier passes looked at, `added` what this one looks at for the first time.
    text, added = "", scan.lower()
    while True:
        tried = [(c, c.fires(text, added)) for c in candidates]
        newly = [c for c, fires in tried if fires]
        if not newly:
            break
        fired += newly
        # An entry kept out of recursion is only ever tried on the text read.
        candidates = [c for c, fires in tried if not fires and not c.exclude_recursion]
        pieces = [strip_decorators(c.entry.get("content") or "").lower()
                  for c in newly if not _setting(c.entry, "prevent_recursion")]
        if not pieces:
            break
        text += added
        added = "\n" + "\n".join(pieces)
    return [c.entry for c in sorted(fired, key=lambda c: c.index)]
