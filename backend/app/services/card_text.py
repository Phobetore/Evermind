"""The text a card's tile shows when the card has no tagline: the first real sentence of its
description, without the markup, the sheets of traits and the blocks that cards often open with.

Descriptions are written by others and imported from anywhere; some are hostile. Every step is one
pass over the text, and a search for a closing mark never starts again from each opening one: a
description of megabytes would otherwise stall the home page. frontend/src/engine/excerpt.ts is the
same rule for the browser edition; the recorded cases (tests/cases/card_excerpt.json) hold both.

"" means no text: the tile then takes the layout of a card without a description.
"""

import re
import unicodedata
from itertools import accumulate

EXCERPT_RULE = 1  # raised by whoever changes the rule below: every stored excerpt is redone

_LENGTH = 160  # two or three lines of a tile
_MIN_LETTERS = 20  # under this, what is left is debris
_SQUARE_BLOCK = 300
_CURLY_BLOCK = 300
_MARKER_BLOCK = 80
_UNREADABLE = 40
_KEY_LINE = 80
_KEY_WORD = 24

_ENTITY_RE = re.compile(r"&(?:(nbsp|amp|lt|gt|quot|apos)|#([0-9]+)|#x([0-9a-fA-F]+));")
_NAMED = {"nbsp": " ", "amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}

# Tag names are ASCII and their case is ASCII's: re.ASCII keeps "ſ" or the Kelvin sign from
# folding into a name, as they would under a Unicode IGNORECASE.
_STOP_RE = re.compile(r"[<!\[\]]")
_NAME_TAG_RE = re.compile(r"<(user|bot|char)>", re.IGNORECASE | re.ASCII)
_TAG_NAME_RE = re.compile(r"</?([a-z][a-z0-9]*)", re.IGNORECASE | re.ASCII)
_TABLE_END_RE = re.compile(r"</table>", re.IGNORECASE | re.ASCII)
_BLOCK_TAGS = frozenset({"br", "hr", "p", "div", "li", "ul", "ol", "tr", "blockquote", "center",
                         "h1", "h2", "h3", "h4", "h5", "h6"})
_NAME_TAGS = {"user": "{{user}}", "bot": "{{char}}", "char": "{{char}}"}

# On a line whose spaces were already made single ones.
_HEADING_RE = re.compile(r"#{1,6} ")
_LEADING_MARKS_RE = re.compile(r"(?:#{1,6} )?(?:> ?)*(?:[-*+] |[0-9]{1,9}[.)] )?")
_KEY_SEPARATOR_RE = re.compile(r"[:=]")

_BRACKET_RE = re.compile(r"[\[\]{}]")
_MARKER_RE = re.compile(r"\{\{\s*(?:char|user)\s*\}\}", re.IGNORECASE)
_TOKEN_RE = re.compile(r"[A-Za-z0-9+/=_-]+")
_DIGIT_RE = re.compile(r"[0-9]")
_EMPHASIS_RE = re.compile(r"[*_~`]")

# Scripts written without spaces between words, where a character carries about a word. Written
# as ranges, the same in TypeScript: Python's re knows no Unicode scripts.
_DENSE = ((0x3040, 0x30FF), (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0x20000, 0x3FFFF))


def card_excerpt(description: str, name: str) -> str:
    text = _ENTITY_RE.sub(_decoded, description)
    text = _without_markup(text)
    text = _without_blocks(" ".join(_first_real_lines(text, name)))
    text = " ".join(word for word in text.split() if not _unreadable(word))
    text = " ".join(_EMPHASIS_RE.sub("", text).split())
    if not _enough_letters(text):
        return ""
    return _cut(text)


def _decoded(match: re.Match) -> str:
    named, decimal, hexadecimal = match.groups()
    if named:
        return _NAMED[named]
    digits = (decimal if decimal is not None else hexadecimal).lstrip("0")
    # Longer is past U+10FFFF anyway, and int refuses more than 4,300 digits.
    if len(digits) > (7 if decimal is not None else 6):
        return match.group()
    value = int(digits or "0", 10 if decimal is not None else 16)
    # Half of a pair alone can be written neither in SQLite nor in UTF-8.
    if value == 0 or value > 0x10FFFF or 0xD800 <= value <= 0xDFFF:
        return match.group()
    return chr(value)


def _next_of(text: str, mark: str):
    """The next position of a mark at or after a position, for positions that only move forward:
    each search starts past the last one found, so all of them read the text once."""
    since, found = -1, -1

    def at(position: int) -> int:
        nonlocal since, found
        if since < 0 or position < since or (found >= 0 and position > found):
            since, found = position, text.find(mark, position)
        return found

    return at


def _without_markup(text: str) -> str:
    """Comments, tables, tags, Markdown images and the syntax of links, in one pass. A block tag
    leaves a line break, so that a sheet written on one line with <br> finds its lines again."""
    length = len(text)
    bracket, paren = _next_of(text, "]"), _next_of(text, ")")

    def image_end(at: int) -> int:
        # The ")" that ends an image "![…](…)" starting at `at`, or -1.
        close = bracket(at + 2)
        if close < 0 or not text.startswith("(", close + 1):
            return -1
        return paren(close + 2)

    out: list[str] = []
    i = 0
    # The "](address)" of a link whose "[" was dropped, left out when the scan reaches it.
    tail_from, tail_to = -1, -1
    while True:
        if tail_from >= 0 and tail_from < i:
            tail_from = -1
        stop = _STOP_RE.search(text, i)
        if not stop:
            out.append(text[i:])
            break
        at = stop.start()
        out.append(text[i:at])
        c = text[at]
        i = at + 1
        if c == "]":
            if at == tail_from:
                i, tail_from = tail_to + 1, -1
            else:
                out.append(c)
        elif c == "!":
            end = image_end(at) if text.startswith("![", at) else -1
            if end >= 0:
                out.append(" ")
                i = end + 1
            else:
                out.append(c)
        elif c == "[":
            end = image_end(at + 1) if text.startswith("![", at + 1) else -1
            if end >= 0 and text.startswith("](", end + 1) and (outer := paren(end + 3)) >= 0:
                # An image inside a link is an image.
                out.append(" ")
                i = outer + 1
                continue
            close = bracket(at + 1)
            if close >= 0 and text.startswith("(", close + 1) and (end := paren(close + 2)) >= 0:
                tail_from, tail_to = close, end
            else:
                out.append(c)
        else:
            i = _after_angle(text, at, length, out)
    return "".join(out)


def _after_angle(text: str, at: int, length: int, out: list[str]) -> int:
    """What a "<" opens, written to `out`; the position after it."""
    named = _NAME_TAG_RE.match(text, at)
    if named:
        out.append(_NAME_TAGS[named.group(1).lower()])
        return named.end()
    if text.startswith("<!--", at):
        end = text.find("-->", at + 4)
        out.append(" ")
        return length if end < 0 else end + 3
    after = text[at + 1:at + 2]
    if not (after in ("/", "!") or (after.isascii() and after.isalpha())):
        out.append("<")
        return at + 1
    tag = _TAG_NAME_RE.match(text, at)
    name = tag.group(1).lower() if tag else ""
    name_end = tag.end() if tag else at + 1
    whole = name_end >= length or text[name_end].isspace() or text[name_end] in "/>"
    if whole and name == "table" and after != "/":
        # In a card, a table is a sheet of traits, never the first sentence.
        end = _TABLE_END_RE.search(text, at)
        out.append("\n")
        return length if end is None else end.end()
    end = text.find(">", at + 1)
    out.append("\n" if whole and name in _BLOCK_TAGS else " ")
    return length if end < 0 else end + 1


def _read_line(raw: str) -> tuple[bool, str]:
    """Whether a line is a Markdown heading, and its text without its leading marks."""
    line = " ".join(raw.split())
    heading = _HEADING_RE.match(line) is not None
    return heading, line[_LEADING_MARKS_RE.match(line).end():].lstrip()


def _first_real_lines(text: str, name: str) -> list[str]:
    # Split on "\n" alone: splitlines() also breaks on U+2028, U+0085 and others that JavaScript
    # does not, and that are spaces here.
    raws = text.replace("\r\n", "\n").replace("\r", "\n").replace("﻿", "").split("\n")
    own_name = " ".join(name.split()).lower()
    # The depth of [ ] and { } at the end of each line, and the lowest it falls from each line on:
    # a block opened on a line is closed on the first later line back at its starting depth.
    ends = list(accumulate(r.count("[") + r.count("{") - r.count("]") - r.count("}") for r in raws))
    lowest = list(accumulate(reversed(ends), min))[::-1] + [float("inf")]
    a = 0
    while a < len(raws):
        start = ends[a - 1] if a else 0
        if ends[a] > start and lowest[a + 1] <= start:
            b = a + 1
            while ends[b] > start:
                b += 1
            a = b + 1
            continue
        # A block never closed is no block: its first line is judged like any other.
        if raws[a] and not raws[a].isspace():
            heading, line = _read_line(raws[a])
            if not _skipped(line, heading, own_name):
                break
        a += 1
    return [_read_line(raw)[1] for raw in raws[a:]]


def _skipped(line: str, heading: bool, own_name: str) -> bool:
    if not line or heading:
        return True
    # A row of a Markdown table, outer pipes or not: a sheet of traits. Its rule line has no
    # letter and goes with the rule at the end.
    if "|" in line:
        return True
    if line.lower() == own_name:
        return True
    # {{char}} alone opens with a brace and closes with one: this rule takes it too.
    if line[0] in "[{(" and line[-1] in ")]}":
        return True
    if _is_attribute(line) or _is_key_value(line):
        return True
    return 2 * sum(1 for c in line if _is_letter(c)) < len(line)


def _is_attribute(line: str) -> bool:
    """A line of W++: one to three words, "(", a text holding a quote, ")", and maybe , ] or }."""
    opening = line.find("(")
    if opening <= 0 or not 1 <= len(line[:opening].split()) <= 3:
        return False
    body = line[:-1] if line[-1] in ",]}" else line
    return body.endswith(")") and len(body) - 1 > opening and '"' in body[opening + 1:-1]


def _is_key_value(line: str) -> bool:
    """`Nom : Sélène`, `Âge = 312`, or a label alone, `Description:`: one to three short words,
    then ":" or "="."""
    if len(line) >= _KEY_LINE:
        return False
    separator = _KEY_SEPARATOR_RE.search(line)
    if not separator:
        return False
    words = line[:separator.start()].split()
    return 1 <= len(words) <= 3 and all(len(word) <= _KEY_WORD for word in words)


def _without_blocks(text: str) -> str:
    """Short blocks between brackets or braces left in the text, each bracket paired in one pass.
    {{char}} and {{user}} stay: the page names them, in the reader's language."""
    square: dict[int, int] = {}
    curly: dict[int, int] = {}
    opened: dict[str, list[int]] = {"[": [], "{": []}
    for found in _BRACKET_RE.finditer(text):
        c, at = found.group(), found.start()
        if c in "[{":
            opened[c].append(at)
        elif (stack := opened["[" if c == "]" else "{"]):
            (square if c == "]" else curly)[stack.pop()] = at
    out: list[str] = []
    kept_from = skip_to = 0
    for found in _BRACKET_RE.finditer(text):
        at = found.start()
        if at < skip_to:
            continue
        c = found.group()
        close = square.get(at) if c == "[" else curly.get(at) if c == "{" else None
        if close is None:
            continue
        size = close - at + 1
        if c == "[":
            removed = size <= _SQUARE_BLOCK
        elif text.startswith("{{", at) and curly.get(at + 1) == close - 1:
            if _MARKER_RE.fullmatch(text, at, close + 1):
                skip_to = close + 1
                continue
            removed = size <= _MARKER_BLOCK
            if not removed:
                # Too long to be a marker: text, whose inner braces are judged on their own.
                skip_to = at + 2
                continue
        else:
            removed = size <= _CURLY_BLOCK
        if removed:
            out.append(text[kept_from:at])
            out.append(" ")
            kept_from = skip_to = close + 1
    out.append(text[kept_from:])
    return "".join(out)


def _unreadable(word: str) -> bool:
    """An address, or base64 or hexadecimal, of 40 characters or more: nothing a tile can show.
    Words joined by punctuation stay, and so does a token with no digit, rare enough."""
    if len(word) < _UNREADABLE:
        return False
    if "://" in word or word.startswith(("www.", "data:")):
        return True
    return _TOKEN_RE.fullmatch(word) is not None and _DIGIT_RE.search(word) is not None


def _is_letter(c: str) -> bool:
    # The vowels and viramas of Hindi, Tamil or Bengali are marks: without them, a sentence of
    # those scripts would be less than half letters.
    return c.isalpha() or unicodedata.category(c)[0] == "M"


def _enough_letters(text: str) -> bool:
    weight = 0
    for c in text:
        if _is_letter(c):
            point = ord(c)
            weight += 2 if any(low <= point <= high for low, high in _DENSE) else 1
            if weight >= _MIN_LETTERS:
                return True
    return False


def _binds(c: str) -> bool:
    """Whether a code point belongs to the one before it: cutting before it splits a character."""
    point = ord(c)
    return (unicodedata.category(c)[0] == "M" or point in (0x200D, 0xFE0E, 0xFE0F)
            or 0x1F3FB <= point <= 0x1F3FF or 0xE0020 <= point <= 0xE007F)


def _cut(text: str) -> str:
    if len(text) <= _LENGTH:
        return text
    cut = _LENGTH
    if text[cut] != " ":
        space = text.rfind(" ", 0, cut)
        if space > 0:
            cut = space
    # Never between a character and what composes it, without Intl.Segmenter on the other side,
    # whose cuts follow the browser's version of ICU.
    while cut > 0 and (_binds(text[cut]) or text[cut - 1] == "‍"):
        cut -= 1
    flags = 0
    while flags < cut and 0x1F1E6 <= ord(text[cut - 1 - flags]) <= 0x1F1FF:
        flags += 1
    if flags % 2:
        cut -= 1
    return text[:cut].rstrip() + "…"
