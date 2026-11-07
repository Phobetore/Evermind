"""Cases recorded from the code: what it answered when they were written down.

From backend/, ``python -m tests.test_recorded_cases`` rewrites every ``expected`` from what the
code returns now. Read the diff: it is the change in behaviour.
"""

import json
import unicodedata
from pathlib import Path

import pytest

from app.prompting import defaults
from app.prompting.memory_changes import plan_consolidation, plan_memory_changes
from app.services.llm_json import parse_llm_json

CASES_DIR = Path(__file__).parent / "cases"


def memory_reply(text, existing, top_position):
    parsed = parse_llm_json(text)
    return None if parsed is None else plan_memory_changes(parsed, existing, top_position)


def consolidation_reply(text, movable):
    return plan_consolidation(parse_llm_json(text), movable)


def default_prompts():
    return {n: v for n, v in vars(defaults).items() if n.isupper() and isinstance(v, str)}


FUNCTIONS = {f.__name__: f for f in (memory_reply, consolidation_reply, default_prompts)}
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
