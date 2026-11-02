"""The shared parity cases: which Python function each one calls, and how the
files in parity/ are written.

Run from backend/ as ``python -m tests.parity_cases`` to rewrite the ``expected``
of every case from what the Python returns now. The TypeScript engine in
frontend/src/engine/ is held to the same files.
"""

import dataclasses
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.prompting import defaults
from app.prompting.macros import has_original_macro, substitute, substitute_original
from app.prompting.tokens import estimate_tokens

PARITY_DIR = Path(__file__).resolve().parents[2] / "parity"


def py_strip(text: str) -> str:
    return text.strip()


def py_lstrip(text: str) -> str:
    return text.lstrip()


def py_rstrip(text: str) -> str:
    return text.rstrip()


def default_prompts() -> dict[str, str]:
    return {
        name: value
        for name, value in vars(defaults).items()
        if name.isupper() and isinstance(value, str)
    }


# One entry per ``fn`` named in the case files; a case calls it with its
# ``input`` as keyword arguments. A function added here needs its twin in the
# registry of frontend/src/engine/parity.test.ts.
FUNCTIONS: dict[str, Callable[..., Any]] = {
    "substitute": substitute,
    "substitute_original": substitute_original,
    "has_original_macro": has_original_macro,
    "estimate_tokens": estimate_tokens,
    "py_strip": py_strip,
    "py_lstrip": py_lstrip,
    "py_rstrip": py_rstrip,
    "default_prompts": default_prompts,
}


def _plain(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    raise TypeError(f"{type(value).__name__} is not JSON data")


def serialize(result: Any) -> Any:
    """What a result looks like once written to a file and read back."""
    return json.loads(json.dumps(result, ensure_ascii=False, allow_nan=False, default=_plain))


def run_case(case: dict[str, Any]) -> Any:
    return serialize(FUNCTIONS[case["fn"]](**case["input"]))


def case_files() -> list[Path]:
    return sorted(PARITY_DIR.glob("*.json"))


def read_cases(path: Path) -> list[dict[str, Any]]:
    return json.loads(path.read_text(encoding="utf-8"))["cases"]


def write_cases(path: Path, cases: list[dict[str, Any]]) -> None:
    text = json.dumps({"cases": cases}, ensure_ascii=False, indent=1, allow_nan=False) + "\n"
    # Bytes, so that Windows does not turn the line ends into CR LF.
    path.write_bytes(text.encode("utf-8"))


def regenerate() -> None:
    for path in case_files():
        cases = read_cases(path)
        changed = 0
        for case in cases:
            expected = run_case(case)
            if case.get("expected") != expected:
                changed += 1
            case["expected"] = expected
        write_cases(path, cases)
        print(f"{path.name}: {len(cases)} cases, {changed} changed")


if __name__ == "__main__":
    regenerate()
