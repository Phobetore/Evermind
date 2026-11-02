"""Every case in parity/ gives, from the Python, the output the file expects.

The TypeScript engine runs the same files (frontend/src/engine/parity.test.ts).
"""

import dataclasses

import pytest

from tests.parity_cases import FUNCTIONS, case_files, read_cases, run_case, serialize

CASES = [
    pytest.param(case, id=f"{path.stem}::{case['fn']}::{case['name']}")
    for path in case_files()
    for case in read_cases(path)
]


def test_the_case_files_are_found_and_read():
    # A wrong path would otherwise run no case at all and pass.
    assert len(case_files()) >= 4
    assert len(CASES) >= 20


@pytest.mark.parametrize("case", CASES)
def test_case(case):
    assert case["fn"] in FUNCTIONS, f"no function registered for {case['fn']!r}"
    assert run_case(case) == case["expected"]


def test_a_result_is_compared_as_it_reads_back_from_a_file():
    @dataclasses.dataclass
    class Inner:
        keys: tuple[str, ...]

    @dataclasses.dataclass
    class Outer:
        name: str
        inner: Inner

    assert serialize(Outer("é", Inner(("a", "b")))) == {"name": "é", "inner": {"keys": ["a", "b"]}}


def test_a_result_that_is_not_json_is_refused():
    with pytest.raises(ValueError):
        serialize(float("nan"))
    with pytest.raises(TypeError):
        serialize(object())
