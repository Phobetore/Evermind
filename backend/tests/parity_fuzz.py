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
"""

import json
import random
import re
from collections.abc import Callable
from typing import Any

from app.prompting.payloads import LIST_FIELDS, TEXT_FIELDS

from .parity_cases import PARITY_DIR, run_case, write_cases

SEED = 20261102
PATH = PARITY_DIR / "fuzz.json"

# How many cases of each kind. The file stays under 500 KB: lower these if it does not.
CHAT_CASES = 75
JSON_CASES = 60
MEMORY_CASES = 40
CONSOLIDATION_CASES = 20
CARD_CASES = 40

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
    "\U000000a0", "\u0085", "\u001c", "\U0000feff", "\U0000200b",
    "$&", "\\1", "{{char}}", "{{ USER }}", "{{original}}",
    "\n", "\n",
]

KINDS = ["fact", "event", "relationship", "promise", "state"]
MODES = ["say", "narrate", "ooc"]


def text(rng: random.Random, low: int, high: int) -> str:
    return "".join(rng.choice(PIECES) for _ in range(rng.randint(low, high)))


def chance(rng: random.Random, probability: float) -> bool:
    return rng.random() < probability


def fact_text(rng: random.Random, taken: int) -> str:
    """A fact as the memory stores it: stripped, and never empty."""
    return text(rng, 1, 4).strip() or f"Fact {taken}."


# ---------------------------------------------------------------- a chat turn

def chat_input(rng: random.Random) -> dict[str, Any]:
    scenario = chance(rng, 0.3)
    character: dict[str, Any] = {
        "kind": "scenario" if scenario else "character",
        "name": text(rng, 0, 4),
        "description": text(rng, 0, 5),
        "personality": text(rng, 0, 4),
        "scenario": text(rng, 0, 4),
        "example_dialogues": text(rng, 0, 4),
        # Always there, and short: without it the long default rules would fill
        # every case. {{original}} brings them back now and then.
        "system_prompt": "Rules: " + text(rng, 0, 6),
    }
    if chance(rng, 0.4):
        character["post_history_instructions"] = text(rng, 0, 4)

    persona = None
    if chance(rng, 0.75):
        persona = {"name": text(rng, 0, 3), "description": text(rng, 0, 4)}

    count = rng.choice([0, 1, 2, 3, 4, 5, 6, 8, 10, 12])
    position = rng.randint(0, 5)
    messages = []
    role = rng.choice(["assistant", "user"])
    for _ in range(count):
        variants = [
            # A few messages are long enough to make the window cut something.
            text(rng, 100, 250) if chance(rng, 0.05) else text(rng, 0, 5)
            for _ in range(rng.choices([1, 2, 3], [7, 2, 1])[0])
        ]
        index = rng.randrange(len(variants))
        if chance(rng, 0.08):
            index = rng.choice([-1, len(variants) + 1])
        message: dict[str, Any] = {"role": role, "variants": variants, "active_index": index,
                                   "position": position}
        if chance(rng, 0.3):
            message["meta"] = {"mode": rng.choice(MODES)}
        messages.append(message)
        role = "user" if role == "assistant" else "assistant"
        position += rng.randint(1, 3)
    if chance(rng, 0.15):
        rng.shuffle(messages)

    memories = []
    for i in range(rng.choice([0, 0, 1, 2, 3, 4, 6, 8, 10])):
        memories.append({"id": f"m{i}", "content": fact_text(rng, i),
                         "is_pinned": chance(rng, 0.25), "source_position": rng.randint(0, 14)})

    lore_entries = []
    for _ in range(rng.choice([0, 0, 1, 2, 3, 5])):
        keys = []
        for _ in range(rng.randint(1, 3)):
            key = text(rng, 1, 2)
            heard = [v for m in messages for v in m["variants"] if v]
            if heard and chance(rng, 0.6):
                # Something the story says, in the case it was said or in another.
                source = rng.choice(heard)
                start = rng.randrange(len(source))
                key = source[start:start + rng.randint(1, 3)]
                key = rng.choice([key, key.upper(), key.lower()])
            keys.append(key)
        lore_entries.append({
            "keys": keys, "content": text(rng, 1, 4), "enabled": not chance(rng, 0.1),
            "case_sensitive": chance(rng, 0.2), "priority": rng.randint(0, 5),
        })

    conversation: dict[str, Any] = {"summary": text(rng, 0, 4)}
    if chance(rng, 0.4):
        conversation["author_note"] = text(rng, 0, 5)

    given: dict[str, Any] = {
        "character": character,
        "persona": persona,
        "conversation": conversation,
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


# ---------------------------------------------------------- what a model writes

def number(rng: random.Random) -> int | float:
    """A number that a file holds and both languages read to the same value: no
    whole float, which JavaScript cannot tell from an integer, and no integer past
    2^53."""
    if chance(rng, 0.6):
        return rng.randint(-1000, 10**9)
    return rng.choice([0.5, -3.75, 2.25, 1e-7, 123456.789, 1.5e300, 0.1])


def json_value(rng: random.Random, depth: int = 0) -> Any:
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


def json_object(rng: random.Random, depth: int = 0) -> dict[str, Any]:
    keys = ["facts", "content", "kind", "summary", "keys", "a", "name", ""]
    return {(text(rng, 1, 2) if chance(rng, 0.3) else rng.choice(keys)): json_value(rng, depth)
            for _ in range(rng.randint(0, 5))}


def dumps(rng: random.Random, value: Any) -> str:
    return json.dumps(value, ensure_ascii=chance(rng, 0.5), indent=rng.choice([None, 1, 2]),
                      allow_nan=False)


# Each damage takes the text of a reply and gives one that models write: a code
# fence around it, talk before and after, a comma too many, a line break written
# for real inside a string, a number that JSON does not have, a reply cut short.
def fenced(rng: random.Random, reply: str) -> str:
    opening = rng.choice(["```json", "```JSON", "```", "``` json", "```json "])
    closing = rng.choice(["```", "```", "``"])
    return f"{opening}\n{reply}\n{closing}"


def talk_before(rng: random.Random, reply: str) -> str:
    return rng.choice(["Sure! Here it is:\n", "{ here is the JSON }\n", "", text(rng, 1, 5)]) + reply


def talk_after(rng: random.Random, reply: str) -> str:
    return reply + rng.choice(["\nHope this helps!", "\n} {", " ]", "\n" + text(rng, 1, 5), ","])


def comma_too_many(rng: random.Random, reply: str) -> str:
    closers = [m.start() for m in re.finditer(r"[}\]]", reply)]
    if not closers:
        return reply
    at = rng.choice(closers)
    return reply[:at] + rng.choice([",", ", ", ",\n"]) + reply[at:]


def real_line_breaks(rng: random.Random, reply: str) -> str:
    return reply.replace("\\n", rng.choice(["\n", "\r\n"])).replace("\\t", "\t")


def not_a_number(rng: random.Random, reply: str) -> str:
    found = list(re.finditer(r"(?<=[:\[,]) ?-?\d+(?:\.\d+)?", reply))
    if not found:
        return reply
    at = rng.choice(found)
    return reply[:at.start()] + " " + rng.choice(["NaN", "Infinity", "-Infinity"]) + reply[at.end():]


def cut_short(rng: random.Random, reply: str) -> str:
    return reply[:rng.randrange(1, len(reply))] if len(reply) > 1 else reply


def lose_a_character(rng: random.Random, reply: str) -> str:
    found = [m.start() for m in re.finditer(r'[}\]"]', reply)]
    if not found:
        return reply
    at = rng.choice(found)
    return reply[:at] + reply[at + 1:]


def said_twice(rng: random.Random, reply: str) -> str:
    return reply + rng.choice(["\n", " ", ""]) + reply


def single_quoted(rng: random.Random, reply: str) -> str:
    return reply.replace('"', "'")


def spaced(rng: random.Random, reply: str) -> str:
    return text(rng, 0, 3) + reply + text(rng, 0, 3)


DAMAGES: list[Callable[[random.Random, str], str]] = [
    fenced, talk_before, talk_after, comma_too_many, real_line_breaks, not_a_number,
    cut_short, lose_a_character, said_twice, single_quoted, spaced,
]


def damaged(rng: random.Random, reply: str, how_many: int | None = None) -> str:
    how_many = rng.choice([0, 1, 1, 1, 2, 2, 3]) if how_many is None else how_many
    for _ in range(how_many):
        reply = rng.choice(DAMAGES)(rng, reply)
    return reply


def pieces_of_json(rng: random.Random) -> str:
    """Valid JSON in pieces, put together in an order and with separators of the
    model's choosing: an object, a list, a string, a number."""
    pieces = [dumps(rng, rng.choice([json_object, json_object, lambda r: json_value(r, 1)])(rng))
              for _ in range(rng.randint(1, 3))]
    out = pieces[0]
    for piece in pieces[1:]:
        out += rng.choice(["", " ", "\n", ", ", "\n\n"]) + piece
    return out


def json_reply(rng: random.Random) -> str:
    return damaged(rng, pieces_of_json(rng))


# ------------------------------------------------------- memory and card inputs

def padded(rng: random.Random, content: str) -> str:
    """A text as a model may write it again: as it is, or with the spaces around that
    Python strips and the ones it does not."""
    return rng.choice([content, content, f" {content} ", f"\U000000a0{content}", f"{content}\U0000feff",
                       content.upper()])


def memory_item(rng: random.Random, known: list[str], reaching: float = 0.3) -> Any:
    """Something a model may put in a list of texts: one that the memory holds
    (``reaching`` of the time, and a correction or a drop needs it), a text of its
    own, or anything else."""
    roll = rng.random()
    if roll < reaching and known:
        return padded(rng, rng.choice(known))
    if roll < reaching + 0.4:
        return text(rng, 0, 6)
    return rng.choice([None, True, 12, 1.5, [], ["a"], {}, {"content": "x"}, ""])


def memory_answer(rng: random.Random, known: list[str]) -> dict[str, Any]:
    answer: dict[str, Any] = {}
    if chance(rng, 0.8):
        answer["facts"] = [
            {"content": memory_item(rng, known),
             "kind": rng.choice([*KINDS, "Event", " event", "", None, 5, "junk"])}
            if chance(rng, 0.85) else memory_item(rng, known)
            for _ in range(rng.randint(0, 5))
        ]
    if chance(rng, 0.5):
        answer["updated_facts"] = [
            {"replaces": memory_item(rng, known, 0.7), "content": memory_item(rng, known)}
            if chance(rng, 0.85) else memory_item(rng, known)
            for _ in range(rng.randint(0, 4))
        ]
    if chance(rng, 0.5):
        answer["obsolete_facts"] = [memory_item(rng, known, 0.7) for _ in range(rng.randint(0, 4))]
    if chance(rng, 0.6):
        answer["summary"] = memory_item(rng, known)
    if chance(rng, 0.1):
        answer[rng.choice(["facts", "updated_facts", "obsolete_facts"])] = rng.choice(
            ["a string", 12, {"content": "x"}, None])
    if chance(rng, 0.2):
        answer["confidence"] = number(rng)
    return answer


def memory_reply_input(rng: random.Random) -> dict[str, Any]:
    existing: list[dict[str, Any]] = []
    for i in range(rng.randint(0, 8)):
        content = rng.choice(existing)["content"] if existing and chance(rng, 0.2) else fact_text(rng, i)
        existing.append({"content": content, "is_pinned": chance(rng, 0.25),
                         "source": "auto" if chance(rng, 0.7) else "user"})
    known = [m["content"] for m in existing]
    reply = dumps(rng, memory_answer(rng, known))
    if chance(rng, 0.4):
        reply = damaged(rng, reply, rng.choice([1, 1, 2]))
    return {"text": reply, "existing": existing, "top_position": rng.randint(1, 50)}


def consolidation_reply_input(rng: random.Random) -> dict[str, Any]:
    facts = [
        {"content": memory_item(rng, []), "kind": rng.choice([*KINDS, "Event", None, 5])}
        if chance(rng, 0.85) else memory_item(rng, [])
        for _ in range(rng.choice([0, 1, 1, 2, 2, 3, 3, 5, 5, 31]))
    ]
    reply = dumps(rng, {"facts": facts} if chance(rng, 0.9) else json_object(rng))
    if chance(rng, 0.4):
        reply = damaged(rng, reply, 1)
    return {"text": reply,
            "movable": [{"source_position": rng.randint(0, 40)} for _ in range(rng.randint(0, 8))]}


def card_words(rng: random.Random) -> Any:
    """What a model may give for a list of keywords or tags."""
    roll = rng.random()
    if roll < 0.7:
        return [rng.choice([text(rng, 1, 3), text(rng, 30, 45), rng.randint(-5, 999),
                            None, True, 1.5, ["x"], ""])
                for _ in range(rng.randint(0, 10))]
    return rng.choice([text(rng, 1, 3), None, 12, {"a": "b"}])


def card_draft_input(rng: random.Random) -> dict[str, Any]:
    draft: dict[str, Any] = {}
    for field in TEXT_FIELDS:
        if chance(rng, 0.7):
            draft[field] = rng.choice([text(rng, 0, 5)] * 5 + [12, None, ["a"], True])
    for field in LIST_FIELDS:
        if chance(rng, 0.7):
            draft[field] = card_words(rng)
    if chance(rng, 0.7):
        draft["lore_entries"] = [
            {"keys": card_words(rng), "content": rng.choice([text(rng, 0, 5)] * 3 + [12, None])}
            if chance(rng, 0.85) else rng.choice(["x", 5, None, []])
            for _ in range(rng.randint(0, 10))
        ]
    return draft


# ------------------------------------------------------------------- the file

def generate() -> list[dict[str, Any]]:
    rng = random.Random(SEED)
    cases: list[dict[str, Any]] = []

    def add(fn: str, label: str, how_many: int, make: Callable[[random.Random], dict]) -> None:
        for index in range(how_many):
            while True:
                case = {"fn": fn, "name": f"{label} {index:03d}", "input": make(rng)}
                try:
                    case["expected"] = run_case(case)
                except ValueError as error:
                    # A NaN or an infinity in the result: no file can hold it.
                    if "not JSON compliant" not in str(error):
                        raise
                    continue
                cases.append(case)
                break

    add("build_chat_payload", "random turn", CHAT_CASES, chat_input)
    add("parse_llm_json", "random reply", JSON_CASES, lambda r: {"text": json_reply(r)})
    add("memory_reply", "random extraction answer", MEMORY_CASES, memory_reply_input)
    add("consolidation_reply", "random consolidation answer", CONSOLIDATION_CASES,
        consolidation_reply_input)
    add("clean_card_draft", "random card draft", CARD_CASES, lambda r: {"draft": card_draft_input(r)})
    return cases


def main() -> None:
    cases = generate()
    write_cases(PATH, cases)
    print(f"{PATH.name}: {len(cases)} cases, {PATH.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
