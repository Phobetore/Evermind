"""Cases recorded from the code: what it answered when they were written down.

From backend/, ``python -m tests.test_recorded_cases`` rewrites every ``expected`` from what the
code returns now. Read the diff: it is the change in behaviour.
"""

import json
import math
import unicodedata
from dataclasses import asdict
from pathlib import Path

import pytest

from app.prompting import defaults, engine, macros, memory_changes, payloads, tokens
from app.prompting.memory_changes import plan_consolidation, plan_memory_changes
from app.services import card_assistant, chat_service, llm_json

CASES_DIR = Path(__file__).parent / "cases"


def memory_reply(text, existing, top_position):
    parsed = llm_json.parse_llm_json(text)
    return None if parsed is None else plan_memory_changes(parsed, existing, top_position)


def consolidation_reply(text, movable):
    return plan_consolidation(llm_json.parse_llm_json(text), movable)


def default_prompts():
    return {n: v for n, v in vars(defaults).items() if n.isupper() and isinstance(v, str)}


# What is not JSON goes through a small envelope, named like the function it calls.

def build_chat_payload(**arguments):
    return asdict(engine.build_chat_payload(**arguments))


def build_impersonate_payload(**arguments):
    return asdict(payloads.build_impersonate_payload(**arguments))


def build_extraction_payload(**arguments):
    built = payloads.build_extraction_payload(**arguments)
    return None if built is None else {"payload": asdict(built[0]), "turns": built[1]}


def build_consolidation_payload(**arguments):
    return asdict(payloads.build_consolidation_payload(**arguments))


def build_card_payload(**arguments):
    return asdict(payloads.build_card_payload(**arguments))


def _finite(value):
    # A browser reads NaN and the infinities outside a string as null: so does a case.
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_finite(v) for v in value]
    return value


def parse_llm_json(text):
    return _finite(llm_json.parse_llm_json(text))


def partial_json(text):
    fields, writing = llm_json.partial_json(text)
    return {"fields": _finite(fields), "writing": writing}


def with_room_for_a_card(connection, payload):
    return card_assistant.with_room_for_a_card(connection, engine.PromptPayload(**payload))


def continue_instruction():
    return chat_service._CONTINUE_INSTRUCTION


def auto_title(content):
    return chat_service._auto_title(content)


FUNCTIONS = {f.__name__: f for f in (
    memory_reply, consolidation_reply, default_prompts,
    build_chat_payload,
    engine.match_lore, engine.select_facts, engine.active_content, engine.is_out_of_character,
    macros.substitute, macros.substitute_original, macros.has_original_macro,
    tokens.estimate_tokens, engine.strip_thought, engine.trim_reply, payloads.words,
    memory_changes.is_movable, payloads.movable_facts, memory_changes.answer_texts,
    build_impersonate_payload, build_extraction_payload, build_consolidation_payload,
    build_card_payload,
    parse_llm_json, partial_json,
    card_assistant.clean_card_draft, with_room_for_a_card,
    continue_instruction, auto_title,
)}
FILES = sorted(CASES_DIR.glob("*.json"))


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))["cases"]


def write(path, cases):
    text = json.dumps({"cases": cases}, ensure_ascii=False, indent=1) + "\n"
    # Anything an editor would hide or fold stays an escape; bytes keep LF on Windows.
    hidden = ("Cc", "Cf", "Cs", "Mn", "Zl", "Zp", "Zs")
    text = "".join(
        (json.dumps(c)[1:-1] if ord(c) > 0xFFFF else f"\\u{ord(c):04x}") if c not in " \n" and unicodedata.category(c) in hidden else c
        for c in text
    )
    path.write_bytes(text.encode("utf-8"))


def run(case):
    return json.loads(json.dumps(FUNCTIONS[case["fn"]](**case["input"])))


@pytest.mark.parametrize("case", [pytest.param(c, id=f"{p.stem}::{c['name']}") for p in FILES for c in read(p)])
def test_case(case):
    assert run(case) == case["expected"]


def test_every_function_has_a_case_and_the_files_are_found():
    assert {c["fn"] for p in FILES for c in read(p)} == set(FUNCTIONS)


def test_a_file_is_what_the_writer_writes(tmp_path):
    # So that regenerating changes nothing but the cases that moved.
    for path in FILES:
        again = tmp_path / path.name
        write(again, read(path))
        assert again.read_bytes() == path.read_bytes()


def test_hidden_characters_beyond_the_basic_plane_survive_a_write(tmp_path):
    flag = "\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F"
    path = tmp_path / "flag.json"
    write(path, [{"input": flag}])
    assert read(path) == [{"input": flag}]


if __name__ == "__main__":
    for path in FILES:
        cases = read(path)
        for case in cases:
            case["expected"] = run(case)
        write(path, cases)
