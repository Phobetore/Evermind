"""Every case in parity/ gives, from the Python, the output the file expects.

The TypeScript engine runs the same files (frontend/src/engine/parity.test.ts).
"""

import dataclasses

import pytest

from tests.parity_cases import (
    FUNCTIONS,
    INVISIBLE,
    case_files,
    read_cases,
    run_case,
    serialize,
    write_cases,
)

CASES = [
    pytest.param(case, id=f"{path.stem}::{case['fn']}::{case['name']}")
    for path in case_files()
    for case in read_cases(path)
]


def test_the_case_files_are_found_and_read():
    # A wrong path would otherwise run no case at all and pass.
    assert len(case_files()) >= 4
    assert len(CASES) >= 20


def test_the_cases_name_exactly_the_registered_functions():
    named = {case["fn"] for path in case_files() for case in read_cases(path)}
    registered = set(FUNCTIONS)
    assert named - registered == set(), "cases name functions that are not registered"
    assert registered - named == set(), "registered functions that no case calls"


@pytest.mark.parametrize("case", CASES)
def test_case(case):
    assert case["fn"] in FUNCTIONS, f"no function registered for {case['fn']!r}"
    assert run_case(case) == case["expected"]


def test_characters_that_cannot_be_seen_are_written_as_escapes(tmp_path):
    # Next line, no-break space, line and paragraph separators, zero width space,
    # byte order mark, Mongolian vowel separator, a combining acute accent and a
    # variation selector.
    odd = "".join(
        chr(code) for code in (0x85, 0xA0, 0x2028, 0x2029, 0x200B, 0xFEFF, 0x180E, 0x301, 0xFE0F)
    )
    case = {"fn": "py_strip", "name": "odd", "input": {"text": odd}, "expected": odd}
    path = tmp_path / "odd.json"
    write_cases(path, [case])
    written = path.read_bytes().decode("utf-8")
    assert written.isascii()
    assert read_cases(path) == [case]


def test_the_case_files_hold_none_of_them_raw():
    for path in case_files():
        text = path.read_bytes().decode("utf-8")
        assert not INVISIBLE.search(text), path.name
        assert "\r" not in text, path.name


def test_a_result_is_compared_as_it_reads_back_from_a_file():
    @dataclasses.dataclass
    class Inner:
        keys: tuple[str, ...]

    @dataclasses.dataclass
    class Outer:
        name: str
        inner: Inner

    assert serialize(Outer("\xe9", Inner(("a", "b")))) == {
        "name": "\xe9",
        "inner": {"keys": ["a", "b"]},
    }


def test_a_result_that_is_not_json_is_refused():
    with pytest.raises(ValueError):
        serialize(float("nan"))
    with pytest.raises(TypeError):
        serialize(object())
