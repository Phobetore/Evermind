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

import numpy

from app.prompting import defaults, engine, payloads, retrieval, turn
from app.prompting.engine import active_content, build_chat_payload, match_lore, select_facts
from app.prompting.macros import has_original_macro, substitute, substitute_original
from app.prompting.memory_changes import (
    memory_after_cut,
    plan_consolidation,
    plan_memory_changes,
    survives_cut,
)
from app.prompting.tokens import estimate_tokens
from app.services.card_assistant import clean_card_draft
from app.services.llm_json import parse_llm_json

PARITY_DIR = Path(__file__).resolve().parents[2] / "parity"


def py_strip(text: str) -> str:
    return text.strip()


def py_lstrip(text: str) -> str:
    return text.lstrip()


def py_rstrip(text: str) -> str:
    return text.rstrip()


def passage_candidates(history: list[dict], stats: dict) -> dict[str, Any]:
    """A set is not JSON: the positions come back as a sorted list."""
    candidates, fact_positions = turn.passage_candidates(history, stats)
    return {"candidates": candidates, "fact_positions": sorted(fact_positions)}


def select_passages(
    ranked: dict[str, float],
    candidates: list[dict],
    token_budget: int,
    exclude_positions: list | None = None,
) -> list[dict]:
    exclude = None if exclude_positions is None else set(exclude_positions)
    return retrieval.select_passages(ranked, candidates, token_budget, exclude)


def cosine_scores(query_vec: list[float], rows: list[list[float]]) -> list[float]:
    """The rows as the matrix that ``rank`` builds. float32, like the vectors in
    the database, so a case may only hold numbers that float32 holds exactly:
    the TypeScript side adds up in double."""
    return retrieval._cosine_scores(query_vec, numpy.array(rows, dtype=numpy.float32))


def build_extraction_payload(
    character: dict,
    persona: dict | None,
    conversation: dict,
    messages: list[dict],
    memories: list[dict],
) -> dict[str, Any] | None:
    """A tuple is not JSON: the payload and the position come back as an object."""
    built = payloads.build_extraction_payload(character, persona, conversation, messages, memories)
    if built is None:
        return None
    payload, top_position = built
    return {"payload": payload, "top_position": top_position}


def payload_limits() -> dict[str, int]:
    return {
        "max_turns_per_run": payloads.MAX_TURNS_PER_RUN,
        "min_facts_to_consolidate": payloads.MIN_FACTS_TO_CONSOLIDATE,
    }


def chat_limits() -> dict[str, float]:
    """The numbers of a chat prompt. A case notices one moving by one only if it happens
    to sit right on it."""
    return {
        "max_pinned_restated": engine._MAX_PINNED_RESTATED,
        "budget_margin": engine._BUDGET_MARGIN,
        "system_share_before_dropping_examples": engine._SYSTEM_SHARE_BEFORE_DROPPING_EXAMPLES,
        "max_facts": engine._MAX_FACTS,
        "facts_token_budget": engine._FACTS_TOKEN_BUDGET,
        "max_facts_token_budget": engine._MAX_FACTS_TOKEN_BUDGET,
        "facts_budget_share": engine._FACTS_BUDGET_SHARE,
        "lore_scan_messages": engine._LORE_SCAN_MESSAGES,
        "lore_token_budget": engine._LORE_TOKEN_BUDGET,
    }


def default_prompts() -> dict[str, str]:
    return {
        name: value
        for name, value in vars(defaults).items()
        if name.isupper() and isinstance(value, str)
    }


def memory_reply(text: str, existing: list[dict], top_position: int) -> dict | None:
    """What an extraction does with a model's answer. None when the answer cannot
    be read: the service raises then."""
    parsed = parse_llm_json(text)
    return None if parsed is None else plan_memory_changes(parsed, existing, top_position)


def consolidation_reply(text: str, movable: list[dict]) -> dict | None:
    """What a consolidation does with a model's answer. None when nothing in it can
    be read: the service raises then."""
    return plan_consolidation(parse_llm_json(text), movable)


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
    "active_content": active_content,
    "build_chat_payload": build_chat_payload,
    "select_facts": select_facts,
    "match_lore": match_lore,
    "trim_reply": turn.trim_reply,
    "continue_history": turn.continue_history,
    "scene_of": turn.scene_of,
    "passage_candidates": passage_candidates,
    "passage_infos": turn.passage_infos,
    "select_passages": select_passages,
    "cosine_scores": cosine_scores,
    "build_impersonate_payload": payloads.build_impersonate_payload,
    "build_summary_payload": payloads.build_summary_payload,
    "build_extraction_payload": build_extraction_payload,
    "movable_facts": payloads.movable_facts,
    "build_consolidation_payload": payloads.build_consolidation_payload,
    "build_card_payload": payloads.build_card_payload,
    "payload_limits": payload_limits,
    "chat_limits": chat_limits,
    "parse_llm_json": parse_llm_json,
    "memory_reply": memory_reply,
    "consolidation_reply": consolidation_reply,
    "survives_cut": survives_cut,
    "memory_after_cut": memory_after_cut,
    "clean_card_draft": clean_card_draft,
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
