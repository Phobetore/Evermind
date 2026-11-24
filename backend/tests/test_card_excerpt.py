"""The first real sentence of a card's description: what a tile shows when the card has no tagline.

The cases themselves are in cases/card_excerpt.json, run by test_recorded_cases.py and by the
TypeScript twin. These tests hold what no single case can: the time a hostile description takes,
and what no result may ever hold.
"""

import json
import re
import time
from pathlib import Path

from app.services.card_text import card_excerpt

CASES = json.loads((Path(__file__).parent / "cases" / "card_excerpt.json").read_text(encoding="utf-8"))["cases"]
MARKERS = re.compile(r"\{\{\s*(?:char|user)\s*\}\}", re.IGNORECASE)


def case(name):
    return next(c for c in CASES if c["name"] == name)


def honest(length):
    # Prose of the same length, in paragraphs, as a card is written.
    paragraph = ("Elle garde le gué depuis trois hivers, et personne ne passe sans lui raconter une "
                 "histoire vraie. ") * 4 + "\n\n"
    return (paragraph * (length // len(paragraph) + 1))[:length]


HOSTILE = {
    "tags": "<a" * 500_000,
    "brackets": "[" * 1_000_000,
    "markers": "{{" * 500_000,
    "images": "![x](" * 200_000,
    "newlines": "\n" * 1_000_000,
    "one word": "a" * 1_000_000,
    "a block never closed": "[\n" * 500_000,
    "long decimal entities": ("&#" + "9" * 5_000 + ";") * 200,
    "a long hexadecimal entity": "&#x" + "f" * 1_000_000 + ";",
}


def test_a_hostile_description_costs_linear_time():
    for label, text in HOSTILE.items():
        prose = honest(len(text))
        start = time.perf_counter()
        card_excerpt(prose, "Sélène")
        once = time.perf_counter() - start
        start = time.perf_counter()
        result = card_excerpt(text, "Sélène")
        elapsed = time.perf_counter() - start
        assert elapsed < 50 * once + 1, label
        assert "<" not in result and "[" not in result, label


# Prose that holds a pipe is text, not a table: these keep theirs.
PIPED_PROSE = {"a prose line holding a pipe opens the excerpt",
               "a long prose line holding a pipe is kept with the short line after it",
               "a line holding a pipe at eighty characters is kept"}


def test_never_markup():
    for c in CASES:
        result = MARKERS.sub("", card_excerpt(**c["input"]))
        assert not re.search(r"<[^\W\d_]", result), c["name"]
        marks = ("](", "[", "{", '("', '" +', "\r", "﻿") + (() if c["name"] in PIPED_PROSE else ("|",))
        for mark in marks:
            assert mark not in result, (c["name"], mark)
        assert not re.search("[\ud800-\udfff]", result), c["name"]


def test_prose_of_every_script_is_kept():
    for name in ("a japanese sentence of fifty characters", "a japanese sentence of fifteen characters",
                 "a chinese paragraph of two hundred characters", "a hindi sentence"):
        description = case(name)["input"]["description"]
        result = card_excerpt(description, "")
        assert result and result.startswith(description[:10]), name


def test_line_endings_do_not_matter():
    crossed = [c for c in CASES if "\n" in c["input"]["description"]]
    assert len(crossed) > 5
    for c in crossed:
        description = c["input"]["description"]
        assert card_excerpt(description.replace("\n", "\r\n"), c["input"]["name"]) == card_excerpt(**c["input"]), c["name"]
