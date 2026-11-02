"""The shared parity cases: which Python function each one calls, and how the
files in parity/ are written.

Run from backend/ as ``python -m tests.parity_cases`` to rewrite the ``expected``
of every case from what the Python returns now. The TypeScript engine in
frontend/src/engine/ is held to the same files.
"""

import dataclasses
import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.prompting import defaults
from app.prompting.engine import build_chat_payload, match_lore, select_facts
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
    "build_chat_payload": build_chat_payload,
    "select_facts": select_facts,
    "match_lore": match_lore,
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


# What a file must not hold raw, because it cannot be seen there, looks like
# something else, or is taken for a line end by an editor that offers to tidy
# it, input and expected alike: DEL, the C1 controls and the no-break space
# (U+007F-U+00A0), the soft hyphen, the Arabic letter mark, the Ogham and
# Mongolian spaces, the spaces, zero-width and direction marks of
# U+2000-U+200F, the line and paragraph separators with the bidirectional
# controls and the narrow no-break space (U+2028-U+202F), the medium
# mathematical space to the last format control of that block (U+205F-U+206F),
# the ideographic space, and the byte order mark; and the combining marks
# (U+0300-U+036F) and variation selectors (U+FE00-U+FE0F), which an editor that
# normalises text would fold into the letter before them. The C0 controls are
# already escaped by json.dumps, and the one line feed left is the layout's own.
INVISIBLE = re.compile(
    "["
    + "".join(
        f"{chr(low)}-{chr(high)}"
        for low, high in [
            (0x7F, 0xA0),
            (0xAD, 0xAD),
            (0x300, 0x36F),
            (0x61C, 0x61C),
            (0x1680, 0x1680),
            (0x180E, 0x180E),
            (0x2000, 0x200F),
            (0x2028, 0x202F),
            (0x205F, 0x206F),
            (0x3000, 0x3000),
            (0xFE00, 0xFE0F),
            (0xFEFF, 0xFEFF),
        ]
    )
    + "]"
)


def write_cases(path: Path, cases: list[dict[str, Any]]) -> None:
    text = json.dumps({"cases": cases}, ensure_ascii=False, indent=1, allow_nan=False)
    text = INVISIBLE.sub(lambda match: f"\\u{ord(match.group()):04x}", text)
    # Bytes, so that Windows does not turn the line ends into CR LF.
    path.write_bytes((text + "\n").encode("utf-8"))


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
