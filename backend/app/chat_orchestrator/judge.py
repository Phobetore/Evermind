"""Judge module — evaluates candidate responses and returns scoring + rewrite suggestion.

Calls the judge LLM with the Addendum §D.2 template and parses the structured
JSON response containing per-candidate scores and a rewrite suggestion.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from app.prompting.assembler import build_judge_prompt

if TYPE_CHECKING:
    from app.core.llm_client import LLMClient

logger = logging.getLogger(__name__)


@dataclass
class CandidateScore:
    """Score for a single candidate response."""

    id: str
    score: float = 0.0
    subscores: dict[str, float] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)


@dataclass
class JudgeResult:
    """Result from the judge evaluation."""

    ranking: list[CandidateScore] = field(default_factory=list)
    best_id: str = ""
    rewrite_suggestion: str = ""
    raw_response: str = ""


def parse_judge_response(raw_text: str) -> JudgeResult:
    """Parse the JSON output from the judge LLM.

    Falls back to a default result on any parse error.
    """
    result = JudgeResult(raw_response=raw_text)

    # Strip markdown fences if the model wraps the JSON
    text = raw_text.strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline == -1:
            logger.warning("Malformed markdown fence in judge response")
            return result
        text = text[first_newline + 1 :]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[: -len("```")]

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("Failed to parse judge JSON: %s", raw_text[:200])
        return result

    if not isinstance(data, dict):
        logger.warning("Judge returned non-dict: %s", type(data))
        return result

    result.best_id = data.get("best_id", "")
    result.rewrite_suggestion = data.get("rewrite_suggestion", "")

    for entry in data.get("ranking", []):
        if not isinstance(entry, dict):
            continue
        try:
            score = float(entry.get("score", 0.0))
        except (TypeError, ValueError):
            score = 0.0
        result.ranking.append(
            CandidateScore(
                id=str(entry.get("id", "")),
                score=score,
                subscores=entry.get("subscores", {}),
                reasons=entry.get("reasons", []),
            )
        )

    return result


async def evaluate_candidates(
    llm: LLMClient,
    *,
    char_name: str,
    writing_style: str,
    boundaries: str,
    world_state_json: str,
    memory_lines_text: str,
    user_message: str,
    candidates: list[str],
) -> JudgeResult:
    """Call the judge LLM to rank *candidates* and return a :class:`JudgeResult`.

    Parameters
    ----------
    llm:
        LLM client pointing to the judge server.
    candidates:
        List of candidate response texts to evaluate.
    """
    messages = build_judge_prompt(
        char_name=char_name,
        writing_style=writing_style,
        boundaries=boundaries,
        world_state_json=world_state_json,
        memory_lines_text=memory_lines_text,
        user_message=user_message,
        candidates=candidates,
    )

    try:
        response: dict[str, Any] = await llm.chat_completion(
            messages, temperature=0.1, max_tokens=1024
        )
        raw_content = (
            response.get("choices", [{}])[0].get("message", {}).get("content", "")
        )
    except Exception:
        logger.exception("Judge LLM call failed")
        return JudgeResult()

    return parse_judge_response(raw_content)
