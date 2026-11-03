"""Random inputs for both prompt engines, written to parity/fuzz.json.

Run from backend/ as ``python -m tests.parity_fuzz``. The inputs come from a fixed
seed and the ``expected`` from the Python, written as every other file of parity/
is (``python -m tests.parity_cases`` rewrites the ``expected`` of this one too,
and leaves the inputs alone). The TypeScript engine in frontend/src/engine/ is
held to the file as to the others.

The cases that people wrote were chosen for what their authors thought of. These
draw text from an alphabet of what tells two implementations apart: code points
outside the basic plane, letters whose case folds differently in Python and in
JavaScript, spaces that one language strips and the other does not, and what a
substitution reads as its own syntax. A divergence the file shows is a defect of
one engine: fix that engine and put the reduced case in the file of its family,
never take the case out.

Random text alone rarely gets as far as a budget, a cut or a macro, so each kind
of chat turn below is made to reach one: a context so small that the history is
cut, a system prompt so heavy that the examples go, a fact or a lore entry too
long for its budget, a card that brings the default rules back with
``{{original}}``, names that a substitution reads as syntax. ``MINIMUMS`` says how
many cases of each the file must hold, and ``test_parity.py`` counts them, so that
a new seed cannot lose one without a test saying so.

Everything is drawn from ``random()`` alone, which Python guarantees to give the
same numbers for the same seed in every version, so the file is the same
wherever it is generated.

Another seed, for a wider look than the file holds, is written beside the others
and read by both test suites:
``python -m tests.parity_fuzz --seed 7 --scale 4 --out ../parity/hunt.json``.
"""

import argparse
import json
import random
import re
import sys
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any
from unittest import mock

from app.prompting import engine
from app.prompting.macros import has_original_macro
from app.prompting.payloads import LIST_FIELDS, TEXT_FIELDS

from .parity_cases import PARITY_DIR, run_case, write_cases

SEED = 20261102
PATH = PARITY_DIR / "fuzz.json"


class Draws:
    """What the generator draws with. Only ``random()`` is guaranteed to give the same
    numbers for a seed in every version of Python, so every other draw is made from it."""

    def __init__(self, seed: int):
        self._random = random.Random(seed).random

    def random(self) -> float:
        return self._random()

    def below(self, n: int) -> int:
        return int(self._random() * n)

    def randint(self, low: int, high: int) -> int:
        return low + self.below(high - low + 1)

    def choice(self, items: list) -> Any:
        return items[self.below(len(items))]

    def weighted(self, items: list, weights: list[int]) -> Any:
        roll = self._random() * sum(weights)
        for item, weight in zip(items, weights, strict=True):
            roll -= weight
            if roll < 0:
                return item
        return items[-1]

    def shuffle(self, items: list) -> None:
        for i in range(len(items) - 1, 0, -1):
            j = self.below(i + 1)
            items[i], items[j] = items[j], items[i]


# How many cases of each kind. The file stays under 500 KB, and these leave it about a
# tenth of that to grow into, since a prompt that grows makes every case that holds it grow.
CHAT_KINDS = [
    ("random turn", 10),
    ("small context", 10),
    ("heavy system prompt", 5),
    ("fact too long for its budget", 4),
    ("lore too long for its budget", 4),
    ("card prompt with a macro", 8),
    ("names a substitution reads", 8),
]
JSON_CASES = 52
MEMORY_CASES = 40
CONSOLIDATION_CASES = 14
CARD_CASES = 24

# A piece is one draw. Each is a unit that a text is made of, so that `$&` and
# `{{ USER }}` come whole.
PIECES = [
    *"aeiknostAEIKNOST0179",
    " ", " ", " ", ".", ",", ":", "!", "?", "-", "'", '"', "*", "(", ")", "[", "]", "/",
    "\U000000e9",  # e acute
    "\U000000df",  # sharp s, which upper-cases to SS
    "\U00000130",  # dotted capital I, which lower-cases to two code points
    "\U00000131",  # dotless i
    "\U0000017f",  # long s, which re.IGNORECASE reads as s
    "\U000003a3",  # capital sigma, which lower-cases to a final sigma at the end of a word
    "\U00000416", "\U00000434", "\U0000044f",  # Cyrillic
    "\U00005b57", "\U00008a9e", "\U00003042",  # CJK
    "\U0001f600", "\U0001f44d", "\U0001f389",  # outside the basic plane
    "\U0001f1eb\U0001f1f7",  # a flag, two regional indicators
    "\U000000a0", "\x85", "\x1c", "\U0000feff", "\U0000200b",
    "$&", "\\1", "{{char}}", "{{ USER }}", "{{original}}",
    "\n", "\n",
]
ASCII_PIECES = [piece for piece in PIECES if piece.isascii()]

# What a name may be made of that a substitution reads as its own syntax: in Python a
# backslash and a digit or a letter, in JavaScript a dollar and a symbol.
HAZARDS = ["$&", "\\1", "\\d", "{{user}}", "$$"]
# The original macro as a card may spell it, with the Turkish i's that
# re.IGNORECASE reads as an i and the flag `i` of JavaScript does not.
ORIGINAL_SPELLINGS = ["{{original}}", "{{ORIGINAL}}", "{{ original }}",
                      "{{or\U00000131g\U00000131nal}}", "{{OR\U00000130G\U00000130NAL}}"]
# Prompts that say nothing to Python's strip, and so bring the default rules back,
# then two that it does not strip.
BLANK_PROMPTS = ["", "\x1c", "\U0000feff"]

KINDS = ["fact", "event", "relationship", "promise", "state"]
MODES = ["say", "narrate", "ooc"]


def text(rng: Draws, low: int, high: int) -> str:
    return "".join(rng.choice(PIECES) for _ in range(rng.randint(low, high)))


def filler(rng: Draws, size: int) -> str:
    """Ascii text of at least ``size`` code points: what is too long for its budget."""
    parts: list[str] = []
    length = 0
    while length < size:
        piece = rng.choice(ASCII_PIECES)
        parts.append(piece)
        length += len(piece)
    return "".join(parts)


def chance(rng: Draws, probability: float) -> bool:
    return rng.random() < probability


def fact_text(rng: Draws, taken: int) -> str:
    """A fact as the memory stores it: stripped, and never empty."""
    return text(rng, 1, 4).strip() or f"Fact {taken}."


# ---------------------------------------------------------------- a chat turn

def conversation(rng: Draws, count: int, low: int, high: int, start: int,
                 one_variant: bool = False) -> list[dict[str, Any]]:
    """``count`` messages, alternating, whose texts have ``low`` to ``high`` pieces."""
    messages = []
    position = start
    role = rng.choice(["assistant", "user"])
    for _ in range(count):
        variants = [
            # A few messages are long enough to make the window cut something.
            text(rng, 100, 250) if chance(rng, 0.05) else text(rng, low, high)
            for _ in range(1 if one_variant else rng.weighted([1, 2, 3], [7, 2, 1]))
        ]
        index = rng.below(len(variants))
        if chance(rng, 0.08):
            index = rng.choice([-1, len(variants) + 1])
        message: dict[str, Any] = {"role": role, "variants": variants, "active_index": index,
                                   "position": position}
        if chance(rng, 0.3):
            message["meta"] = {"mode": rng.choice(MODES)}
        messages.append(message)
        role = "user" if role == "assistant" else "assistant"
        position += rng.randint(1, 3)
    return messages


def lore_entry(rng: Draws, heard: list[str], content: str | None = None) -> dict[str, Any]:
    keys = []
    for _ in range(rng.randint(1, 3)):
        key = text(rng, 1, 2)
        if heard and chance(rng, 0.6):
            # Something the story says, in the case it was said or in another.
            source = rng.choice(heard)
            start = rng.below(len(source))
            key = source[start:start + rng.randint(1, 3)]
            key = rng.choice([key, key.upper(), key.lower()])
        keys.append(key)
    return {"keys": keys, "content": text(rng, 1, 4) if content is None else content,
            "enabled": not chance(rng, 0.1), "case_sensitive": chance(rng, 0.2),
            "priority": rng.randint(0, 5)}


def chat_input(rng: Draws) -> dict[str, Any]:
    character: dict[str, Any] = {
        "kind": "scenario" if chance(rng, 0.3) else "character",
        "name": text(rng, 0, 4),
        "description": text(rng, 0, 5),
        "personality": text(rng, 0, 4),
        "scenario": text(rng, 0, 4),
        "example_dialogues": text(rng, 0, 4),
        # Always there, and short: without it the long default rules would fill
        # every case. The kinds that want them say so.
        "system_prompt": "Rules: " + text(rng, 0, 6),
    }
    if chance(rng, 0.4):
        character["post_history_instructions"] = text(rng, 0, 4)

    persona = None
    if chance(rng, 0.75):
        persona = {"name": text(rng, 0, 3), "description": text(rng, 0, 4)}

    messages = conversation(rng, rng.choice([0, 1, 2, 3, 4, 5, 6, 8, 10, 12]), 0, 5,
                            rng.randint(0, 5))
    if chance(rng, 0.15):
        rng.shuffle(messages)

    memories = []
    for i in range(rng.choice([0, 0, 1, 2, 3, 4, 6, 8, 10])):
        memories.append({"id": f"m{i}", "content": fact_text(rng, i),
                         "is_pinned": chance(rng, 0.25), "source_position": rng.randint(0, 14)})

    heard = [v for m in messages for v in m["variants"] if v]
    lore_entries = [lore_entry(rng, heard) for _ in range(rng.choice([0, 0, 1, 2, 3, 5]))]

    chat: dict[str, Any] = {"summary": text(rng, 0, 4)}
    if chance(rng, 0.4):
        chat["author_note"] = text(rng, 0, 5)

    given: dict[str, Any] = {
        "character": character,
        "persona": persona,
        "conversation": chat,
        "messages": messages,
        "connection": {"context_size": rng.randint(600, 4000),
                       "max_tokens": rng.choice([16, 64, 128, 256, 400])},
        "reply_length": rng.choice(["short", "medium", "medium", "long"]),
    }
    if chance(rng, 0.3):
        given["global_instructions"] = text(rng, 1, 4)
    if memories:
        given["memories"] = memories
        if chance(rng, 0.25):
            # Tenths, so that two facts tie now and then.
            given["relevance_scores"] = {m["id"]: rng.randint(0, 9) / 10 for m in memories
                                         if chance(rng, 0.8)}
    if lore_entries:
        given["lore_entries"] = lore_entries
    if chance(rng, 0.15):
        given["retrieved_passages"] = [
            {"role": rng.choice(["user", "assistant"]), "position": rng.randint(0, 12),
             "content": text(rng, 1, 5)}
            for _ in range(rng.randint(1, 3))
        ]
    if chance(rng, 0.25):
        given["history_limit"] = rng.randint(1, 8)
    if chance(rng, 0.2):
        given["fold_leading_assistant"] = True
    return given


def small_context_input(rng: Draws, index: int) -> dict[str, Any]:
    """The room left for the history is about 250 tokens: ten messages do not fit."""
    given = chat_input(rng)
    given["connection"] = {"context_size": rng.randint(600, 900),
                           "max_tokens": rng.choice([16, 64, 128])}
    given["messages"] = conversation(rng, rng.randint(8, 11), 45, 100, rng.randint(0, 5),
                                     one_variant=True)
    # What would also cut or move the history is left out, so that the budget does it.
    given.pop("history_limit", None)
    given.pop("fold_leading_assistant", None)
    return given


def heavy_system_input(rng: Draws, index: int) -> dict[str, Any]:
    """A system prompt of more than 60% of the budget: the examples are dropped first."""
    given = chat_input(rng)
    given["connection"] = {"context_size": rng.randint(600, 800),
                           "max_tokens": rng.choice([16, 64, 128])}
    card = given["character"]
    card["description"] = text(rng, 100, 160)
    card["personality"] = text(rng, 60, 100)
    card["scenario"] = text(rng, 60, 100)
    card["example_dialogues"] = text(rng, 200, 300)
    given["conversation"]["summary"] = text(rng, 100, 160)
    given["messages"] = conversation(rng, rng.randint(1, 4), 0, 6, rng.randint(0, 5))
    return given


def long_fact_input(rng: Draws, index: int) -> dict[str, Any]:
    """A fact of more than 700 tokens, the least that the facts may take, among others."""
    given = chat_input(rng)
    given["connection"]["context_size"] = rng.randint(2500, 4000)
    given["messages"] = conversation(rng, rng.randint(2, 5), 0, 5, rng.randint(6, 9))
    memories = [{"id": f"m{i}", "content": fact_text(rng, i), "is_pinned": chance(rng, 0.2),
                 "source_position": rng.randint(0, 4)} for i in range(rng.randint(1, 4))]
    memories.append({"id": "long", "content": filler(rng, rng.randint(2700, 3300)),
                     "is_pinned": False, "source_position": rng.randint(0, 4)})
    rng.shuffle(memories)
    given["memories"] = memories
    given.pop("relevance_scores", None)
    return given


def long_lore_input(rng: Draws, index: int) -> dict[str, Any]:
    """Lore that the scene calls for and the lore budget (800 tokens) cannot hold."""
    given = chat_input(rng)
    given["connection"]["context_size"] = rng.randint(2500, 4000)
    messages = conversation(rng, rng.randint(2, 5), 0, 5, rng.randint(0, 5))
    # What the entries below are keyed to, said in the newest turn.
    last = messages[-1]
    shown = last["active_index"] if 0 <= last["active_index"] < len(last["variants"]) else -1
    last["variants"][shown] += " zq"
    given["messages"] = messages
    heard = [v for m in messages for v in m["variants"] if v]
    if index % 3 == 2:
        # Two that are 500 tokens each: the first is kept and the second does not fit.
        entries = [lore_entry(rng, heard, filler(rng, 1700)) for _ in range(2)]
    else:
        entries = [lore_entry(rng, heard, filler(rng, rng.randint(3000, 3400)))]
        entries += [lore_entry(rng, heard) for _ in range(rng.randint(0, 2))]
    for entry in entries:
        entry.update(keys=["zq"], enabled=True, case_sensitive=False)
    entries[0]["priority"] = 5
    given["lore_entries"] = entries
    return given


def card_macro_input(rng: Draws, index: int) -> dict[str, Any]:
    """A card whose prompt brings the default rules back, or says nothing and has them
    brought back. The rules are the longest text of any case, so these are few."""
    given = chat_input(rng)
    given["character"]["kind"] = "scenario" if index % 3 == 2 else "character"
    which = index % (len(ORIGINAL_SPELLINGS) + len(BLANK_PROMPTS))
    if which < len(ORIGINAL_SPELLINGS):
        given["character"]["system_prompt"] = (
            "Rules: " + text(rng, 0, 2) + ORIGINAL_SPELLINGS[which] + text(rng, 0, 2))
    else:
        given["character"]["system_prompt"] = BLANK_PROMPTS[which - len(ORIGINAL_SPELLINGS)]
    return given


def names_input(rng: Draws, index: int) -> dict[str, Any]:
    """Names that a substitution reads as syntax, in texts that substitute them."""
    given = chat_input(rng)
    macros = " {{char}} and {{ USER }}, {{user}}"
    given["character"]["name"] = HAZARDS[index % len(HAZARDS)] + text(rng, 0, 2)
    given["persona"] = {"name": HAZARDS[(index + 2) % len(HAZARDS)] + text(rng, 0, 2),
                        "description": text(rng, 0, 4) + macros}
    given["character"]["description"] += macros
    given["conversation"]["summary"] += macros
    for message in given["messages"][:2]:
        message["variants"][0] += macros
    return given


# ---------------------------------------------------------- what a model writes

def number(rng: Draws) -> int | float:
    """A number that a file holds and both languages read to the same value: no
    whole float, which JavaScript cannot tell from an integer, and no integer past
    2^53."""
    if chance(rng, 0.6):
        return rng.randint(-1000, 10**9)
    return rng.choice([0.5, -3.75, 2.25, 1e-7, 123456.789, 1.5e300, 0.1])


def json_value(rng: Draws, depth: int = 0) -> Any:
    kinds = ["text", "text", "number", "bool", "null"]
    if depth < 3:
        kinds += ["list", "object"]
    kind = rng.choice(kinds)
    if kind == "text":
        return text(rng, 0, 6)
    if kind == "number":
        return number(rng)
    if kind == "bool":
        return chance(rng, 0.5)
    if kind == "null":
        return None
    if kind == "list":
        return [json_value(rng, depth + 1) for _ in range(rng.randint(0, 4))]
    return json_object(rng, depth + 1)


def json_object(rng: Draws, depth: int = 0) -> dict[str, Any]:
    keys = ["facts", "content", "kind", "summary", "keys", "a", "name", ""]
    return {(text(rng, 1, 2) if chance(rng, 0.3) else rng.choice(keys)): json_value(rng, depth)
            for _ in range(rng.randint(0, 5))}


def dumps(rng: Draws, value: Any) -> str:
    return json.dumps(value, ensure_ascii=chance(rng, 0.5), indent=rng.choice([None, 1, 2]),
                      allow_nan=False)


# Each damage takes the text of a reply and gives one that models write: a code
# fence around it, talk before and after, a comma too many, a line break written
# for real inside a string, a number that JSON does not have, a reply cut short.
def fenced(rng: Draws, reply: str) -> str:
    opening = rng.choice(["```json", "```JSON", "```", "``` json", "```json "])
    closing = rng.choice(["```", "```", "``"])
    return f"{opening}\n{reply}\n{closing}"


def talk_before(rng: Draws, reply: str) -> str:
    return rng.choice(["Sure! Here it is:\n", "{ here is the JSON }\n", "", text(rng, 1, 5)]) + reply


def talk_after(rng: Draws, reply: str) -> str:
    return reply + rng.choice(["\nHope this helps!", "\n} {", " ]", "\n" + text(rng, 1, 5), ","])


def comma_too_many(rng: Draws, reply: str) -> str:
    closers = [m.start() for m in re.finditer(r"[}\]]", reply)]
    if not closers:
        return reply
    at = rng.choice(closers)
    return reply[:at] + rng.choice([",", ", ", ",\n"]) + reply[at:]


def real_line_breaks(rng: Draws, reply: str) -> str:
    return reply.replace("\\n", rng.choice(["\n", "\r\n"])).replace("\\t", "\t")


def not_a_number(rng: Draws, reply: str) -> str:
    found = list(re.finditer(r"(?<=[:\[,]) ?-?\d+(?:\.\d+)?", reply))
    if not found:
        return reply
    at = rng.choice(found)
    return reply[:at.start()] + " " + rng.choice(["NaN", "Infinity", "-Infinity"]) + reply[at.end():]


def cut_short(rng: Draws, reply: str) -> str:
    return reply[:rng.randint(1, len(reply) - 1)] if len(reply) > 1 else reply


def lose_a_character(rng: Draws, reply: str) -> str:
    found = [m.start() for m in re.finditer(r'[}\]"]', reply)]
    if not found:
        return reply
    at = rng.choice(found)
    return reply[:at] + reply[at + 1:]


def said_twice(rng: Draws, reply: str) -> str:
    return reply + rng.choice(["\n", " ", ""]) + reply


def single_quoted(rng: Draws, reply: str) -> str:
    return reply.replace('"', "'")


def spaced(rng: Draws, reply: str) -> str:
    return text(rng, 0, 3) + reply + text(rng, 0, 3)


DAMAGES: list[Callable[[Draws, str], str]] = [
    fenced, talk_before, talk_after, comma_too_many, real_line_breaks, not_a_number,
    cut_short, lose_a_character, said_twice, single_quoted, spaced,
]


def damaged(rng: Draws, reply: str, how_many: int | None = None) -> str:
    how_many = rng.choice([0, 1, 1, 1, 2, 2, 3]) if how_many is None else how_many
    for _ in range(how_many):
        reply = rng.choice(DAMAGES)(rng, reply)
    return reply


def pieces_of_json(rng: Draws) -> str:
    """Valid JSON in pieces, put together in an order and with separators of the
    model's choosing: an object, a list, a string, a number."""
    pieces = [dumps(rng, rng.choice([json_object, json_object, lambda r: json_value(r, 1)])(rng))
              for _ in range(rng.randint(1, 3))]
    out = pieces[0]
    for piece in pieces[1:]:
        out += rng.choice(["", " ", "\n", ", ", "\n\n"]) + piece
    return out


def json_reply(rng: Draws, index: int) -> dict[str, Any]:
    return {"text": damaged(rng, pieces_of_json(rng))}


# ------------------------------------------------------- memory and card inputs

def padded(rng: Draws, content: str, strippable: bool = False) -> str:
    """A text as a model may write it again: as it is, or with the spaces around that
    Python strips and, unless ``strippable``, the ones it does not, or in capitals."""
    if strippable:
        return rng.choice([content, content, f" {content} ", f"\U000000a0{content}\U00003000",
                           f"\x1c{content}\n"])
    return rng.choice([content, f" {content} ", f"{content}\U0000feff", content.upper()])


def memory_item(rng: Draws, known: list[str]) -> Any:
    """Something a model may put in a list of texts: one that the memory holds, a text
    of its own, or anything else."""
    roll = rng.random()
    if roll < 0.3 and known:
        return padded(rng, rng.choice(known))
    if roll < 0.7:
        return text(rng, 0, 6)
    return rng.choice([None, True, 12, 1.5, [], ["a"], {}, {"content": "x"}, ""])


def memory_target(rng: Draws, everything: list[str], movable: list[str]) -> Any:
    """What a correction or a drop names. Mostly a fact that the model wrote and nobody
    pinned, since that is the one it may reach; sometimes one it may not, or none."""
    roll = rng.random()
    if roll < 0.6 and movable:
        return padded(rng, rng.choice(movable), strippable=chance(rng, 0.8))
    if roll < 0.85 and everything:
        return padded(rng, rng.choice(everything), strippable=True)
    return memory_item(rng, everything)


def memory_answer(rng: Draws, everything: list[str], movable: list[str]) -> dict[str, Any]:
    answer: dict[str, Any] = {}
    if chance(rng, 0.8):
        answer["facts"] = [
            {"content": text(rng, 1, 5) if chance(rng, 0.6) else memory_item(rng, everything),
             "kind": rng.choice([*KINDS, "Event", " event", "", None, 5, "junk"])}
            if chance(rng, 0.85) else memory_item(rng, everything)
            for _ in range(rng.randint(1, 4))
        ]
    if chance(rng, 0.8):
        answer["updated_facts"] = [
            {"replaces": memory_target(rng, everything, movable),
             "content": text(rng, 1, 5) if chance(rng, 0.7) else memory_item(rng, everything)}
            if chance(rng, 0.9) else memory_item(rng, everything)
            for _ in range(rng.randint(1, 3))
        ]
    if chance(rng, 0.8):
        answer["obsolete_facts"] = [memory_target(rng, everything, movable)
                                    for _ in range(rng.randint(1, 3))]
    if chance(rng, 0.6):
        answer["summary"] = memory_item(rng, everything)
    if chance(rng, 0.1):
        answer[rng.choice(["facts", "updated_facts", "obsolete_facts"])] = rng.choice(
            ["a string", 12, {"content": "x"}, None])
    if chance(rng, 0.2):
        answer["confidence"] = number(rng)
    return answer


def memory_reply_input(rng: Draws, index: int) -> dict[str, Any]:
    existing: list[dict[str, Any]] = []
    for i in range(rng.randint(3, 8)):
        content = rng.choice(existing)["content"] if existing and chance(rng, 0.15) \
            else fact_text(rng, i)
        # The first two are the model's and not pinned, which are the ones it may reach.
        movable = i < 2 or chance(rng, 0.5)
        existing.append({"content": content, "is_pinned": False if movable else chance(rng, 0.5),
                         "source": "auto" if movable or chance(rng, 0.5) else "user"})
    everything = [m["content"] for m in existing]
    movable = [m["content"] for m in existing if not m["is_pinned"] and m["source"] == "auto"]
    reply = dumps(rng, memory_answer(rng, everything, movable))
    if chance(rng, 0.4):
        reply = damaged(rng, reply, rng.choice([1, 1, 2]))
    return {"text": reply, "existing": existing, "top_position": rng.randint(1, 50)}


def consolidation_reply_input(rng: Draws, index: int) -> dict[str, Any]:
    if index % 7 == 0:
        # More facts than one consolidation may leave, and all of them readable.
        facts = [{"content": f"Merged {i}.", "kind": rng.choice(KINDS)} for i in range(31)]
    else:
        facts = [
            {"content": memory_item(rng, []), "kind": rng.choice([*KINDS, "Event", None, 5])}
            if chance(rng, 0.85) else memory_item(rng, [])
            for _ in range(rng.choice([0, 1, 1, 2, 2, 3, 3, 5, 5]))
        ]
    reply = dumps(rng, {"facts": facts} if index % 7 == 0 or chance(rng, 0.9) else json_object(rng))
    if index % 7 != 0 and chance(rng, 0.4):
        reply = damaged(rng, reply, 1)
    return {"text": reply,
            "movable": [{"source_position": rng.randint(0, 40)} for _ in range(rng.randint(0, 8))]}


def card_words(rng: Draws) -> Any:
    """What a model may give for a list of keywords or tags."""
    roll = rng.random()
    if roll < 0.7:
        return [rng.choice([text(rng, 1, 3), text(rng, 30, 45), rng.randint(-5, 999),
                            None, True, 1.5, ["x"], ""])
                for _ in range(rng.randint(0, 10))]
    return rng.choice([text(rng, 1, 3), None, 12, {"a": "b"}])


def good_words(rng: Draws, count: int, long_ones: bool = False) -> list[Any]:
    """Words that a card keeps: texts that are not blank, every other one longer than
    the 40 code points of a tag when ``long_ones``, and now and then a whole number."""
    words: list[Any] = []
    for i in range(count):
        word = f"k{i}" + (filler(rng, 45) if long_ones and i % 2 == 0 else text(rng, 0, 2))
        words.append(rng.randint(1, 999) if chance(rng, 0.1) else word)
    return words


def card_draft_input(rng: Draws, index: int) -> dict[str, Any]:
    draft: dict[str, Any] = {}
    for field in TEXT_FIELDS:
        if chance(rng, 0.7):
            draft[field] = rng.choice([text(rng, 0, 5)] * 5 + [12, None, ["a"], True])
    for field in LIST_FIELDS:
        if chance(rng, 0.7):
            draft[field] = card_words(rng)
    if index % 5 == 0:
        # Every cap at once: more tags than 8, tags longer than 40 code points, more
        # lore entries than 8, more keys than 6.
        draft["tags"] = good_words(rng, rng.randint(9, 10), long_ones=True)
        draft["lore_entries"] = [
            {"keys": good_words(rng, rng.randint(1, 8)), "content": text(rng, 1, 3) + "x"}
            for _ in range(rng.randint(9, 10))
        ]
    elif chance(rng, 0.7):
        draft["lore_entries"] = [
            {"keys": card_words(rng), "content": rng.choice([text(rng, 0, 5)] * 3 + [12, None])}
            if chance(rng, 0.85) else rng.choice(["x", 5, None, []])
            for _ in range(rng.randint(0, 10))
        ]
    return draft


# ------------------------------------------------------------------- the file

def generate(seed: int = SEED, scale: int = 1) -> list[dict[str, Any]]:
    rng = Draws(seed)
    cases: list[dict[str, Any]] = []

    def add(fn: str, label: str, how_many: int, make: Callable[[Draws, int], dict]) -> None:
        for index in range(how_many * scale):
            while True:
                case = {"fn": fn, "name": f"{label} {index:03d}", "input": make(rng, index)}
                try:
                    case["expected"] = run_case(case)
                except ValueError as error:
                    # A NaN or an infinity in the result: no file can hold it.
                    if "not JSON compliant" not in str(error):
                        raise
                    continue
                cases.append(case)
                break

    makers: dict[str, Callable[[Draws, int], dict]] = {
        "random turn": lambda r, i: chat_input(r),
        "small context": small_context_input,
        "heavy system prompt": heavy_system_input,
        "fact too long for its budget": long_fact_input,
        "lore too long for its budget": long_lore_input,
        "card prompt with a macro": card_macro_input,
        "names a substitution reads": names_input,
    }
    for label, how_many in CHAT_KINDS:
        add("build_chat_payload", label, how_many, makers[label])
    add("parse_llm_json", "random reply", JSON_CASES, json_reply)
    add("memory_reply", "random extraction answer", MEMORY_CASES, memory_reply_input)
    add("consolidation_reply", "random consolidation answer", CONSOLIDATION_CASES,
        consolidation_reply_input)
    add("clean_card_draft", "random card draft", CARD_CASES,
        lambda r, i: {"draft": card_draft_input(r, i)})
    return cases


# ------------------------------------------------------------------- coverage

# What the file must hold, at least, for it to be worth running. Counted by
# ``coverage`` from the cases as they are written, and held by test_parity.py.
MINIMUMS = {
    "history cut by the token budget": 8,
    "used tokens above 70% of the budget": 10,
    "examples dropped for the system prompt's size": 5,
    "a fact skipped by the facts budget": 3,
    "a lore entry skipped by the lore budget": 3,
    "{{original}} in a card prompt": 1,
    "{{ORIGINAL}} in a card prompt": 1,
    "{{ original }} in a card prompt": 1,
    "dotted or dotless i in an original macro": 2,
    "default rules in the output": 6,
    "scenario rules in the output": 2,
    "$& in a name, with a macro to replace": 2,
    "\\1 in a name, with a macro to replace": 2,
    "\\d in a name, with a macro to replace": 2,
    "{{user}} in a name, with a macro to replace": 2,
    "an answer to a memory pass that is read": 30,
    "an add": 25,
    "an update": 15,
    "a delete": 15,
    "a consolidation cut to its 30 facts": 2,
    "a reply read as a JSON object": 30,
    "a reply that cannot be read": 3,
    "a card draft with more than 8 lore entries": 5,
    "a card draft kept to 8 lore entries": 3,
    "a card draft with lore keys kept to 6": 2,
    "a card draft with tags kept to 8": 2,
    "a card draft with a tag cut at 40 code points": 2,
}

_MACRO = re.compile(r"\{\{\s*(char|user)\s*\}\}", re.IGNORECASE)


def coverage(cases: list[dict[str, Any]]) -> Counter:
    """How many cases reach each of the things in ``MINIMUMS``."""
    found: Counter = Counter()

    def spy_on_facts() -> tuple[Callable, list[bool]]:
        skipped: list[bool] = []
        real = engine.select_facts

        def select_facts(memories, *args, **kwargs):
            kept = real(memories, *args, **kwargs)
            skipped.append(len(kept) < len(memories))
            return kept
        return select_facts, skipped

    for case in cases:
        given, got = case["input"], case["expected"]
        if case["fn"] == "build_chat_payload":
            stats, system = got["stats"], got["system"]
            card, persona = given["character"], given.get("persona") or {}
            if (stats["messages_included"] < stats["messages_total"]
                    and "history_limit" not in given and not stats["leading_assistant_folded"]):
                found["history cut by the token budget"] += 1
            if stats["used_tokens"] > 0.7 * stats["budget"]:
                found["used tokens above 70% of the budget"] += 1
            if card.get("example_dialogues") and "### EXAMPLE OF HOW YOU WRITE" not in system:
                found["examples dropped for the system prompt's size"] += 1
            facts, skipped = spy_on_facts()
            with mock.patch.object(engine, "select_facts", facts):
                engine.build_chat_payload(**given)
            if any(skipped):
                found["a fact skipped by the facts budget"] += 1
            entries = given.get("lore_entries") or []
            free = [{**entry, "content": ""} for entry in entries]
            if len(engine.match_lore(free, given["messages"])) > stats["lore_matched"]:
                found["a lore entry skipped by the lore budget"] += 1
            prompt = card["system_prompt"]
            for spelling in ("{{original}}", "{{ORIGINAL}}", "{{ original }}"):
                if spelling in prompt:
                    found[f"{spelling} in a card prompt"] += 1
            if has_original_macro(prompt) and re.search("[\U00000130\U00000131]", prompt):
                found["dotted or dotless i in an original macro"] += 1
            if "ROLEPLAY RULES" in system:
                found["default rules in the output"] += 1
                if card["kind"] == "scenario":
                    found["scenario rules in the output"] += 1
            texts = " ".join([card.get("description", ""), persona.get("description") or ""])
            for hazard in ("$&", "\\1", "\\d", "{{user}}"):
                if (hazard in card["name"] or hazard in (persona.get("name") or "")) \
                        and _MACRO.search(texts):
                    found[f"{hazard} in a name, with a macro to replace"] += 1
        elif case["fn"] == "memory_reply":
            if got is not None:
                found["an answer to a memory pass that is read"] += 1
                for op in {op["op"] for op in got["ops"]}:
                    found[{"add": "an add", "update": "an update",
                           "delete": "a delete"}[op]] += 1
        elif case["fn"] == "consolidation_reply":
            if got is not None and len(got["facts"]) == 30:
                found["a consolidation cut to its 30 facts"] += 1
        elif case["fn"] == "parse_llm_json":
            found["a reply read as a JSON object" if got is not None
                  else "a reply that cannot be read"] += 1
        elif case["fn"] == "clean_card_draft":
            lore = given["draft"].get("lore_entries")
            if isinstance(lore, list) and len(lore) > 8:
                found["a card draft with more than 8 lore entries"] += 1
            if len(got.get("lore_entries", [])) == 8:
                found["a card draft kept to 8 lore entries"] += 1
            if any(len(entry["keys"]) == 6 for entry in got.get("lore_entries", [])):
                found["a card draft with lore keys kept to 6"] += 1
            if len(got.get("tags", [])) == 8:
                found["a card draft with tags kept to 8"] += 1
            if any(len(tag) == 40 for tag in got.get("tags", [])):
                found["a card draft with a tag cut at 40 code points"] += 1
    return found


def shortfalls(cases: list[dict[str, Any]]) -> list[str]:
    found = coverage(cases)
    return [f"{name}: {found[name]}, at least {least} wanted"
            for name, least in MINIMUMS.items() if found[name] < least]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write the random cases of parity/fuzz.json.")
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--scale", type=int, default=1,
                        help="draw this many times as many cases of each kind")
    parser.add_argument("--out", type=Path, default=PATH,
                        help="where to write the cases (the committed file by default)")
    args = parser.parse_args(argv)
    if args.out.resolve() == PATH.resolve() and (args.seed, args.scale) != (SEED, 1):
        parser.error("the committed file is the seed's and the scale's own: say where to write "
                     "another with --out")
    cases = generate(args.seed, args.scale)
    write_cases(args.out, cases)
    print(f"{args.out.name}: {len(cases)} cases, {args.out.stat().st_size // 1024} KB")
    problems = shortfalls(cases)
    for problem in problems:
        print("too few:", problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
