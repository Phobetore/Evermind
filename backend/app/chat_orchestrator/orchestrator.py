"""Chat orchestrator — best-of-N generation, judge scoring, and self-refine.

This module implements the v1.0 generation pipeline:

  1. Generate N candidate responses (with temperature/seed variation).
  2. Call the judge LLM to rank candidates.
  3. Optionally self-refine the best candidate using the judge's suggestion.
  4. Return the final response.
"""

from __future__ import annotations

import logging
import random
from typing import TYPE_CHECKING, Any

from app.chat_orchestrator.judge import JudgeResult, evaluate_candidates
from app.prompting.assembler import build_refine_prompt

if TYPE_CHECKING:
    from app.core.llm_client import LLMClient

logger = logging.getLogger(__name__)

# Upper bound for random seed generation (fits in a signed 32-bit integer).
_MAX_SEED = 2**31 - 1


async def generate_single(
    llm: LLMClient,
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.7,
    max_tokens: int = 1024,
    seed: int | None = None,
    extra_params: dict[str, Any] | None = None,
) -> str:
    """Generate a single non-streaming response from the LLM.

    Returns the assistant content string (empty string on failure).
    """
    params: dict[str, Any] = {
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if seed is not None:
        params["seed"] = seed
    if extra_params:
        params.update(extra_params)

    try:
        response = await llm.chat_completion(messages, **params)
        return (
            response.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
    except Exception:
        logger.exception("Single generation failed")
        return ""


async def generate_best_of_n(
    llm: LLMClient,
    messages: list[dict[str, str]],
    *,
    n: int = 3,
    base_temperature: float = 0.7,
    max_tokens: int = 1024,
    base_seed: int | None = None,
    extra_params: dict[str, Any] | None = None,
) -> list[str]:
    """Generate *n* candidate responses with slight parameter variation.

    Each candidate uses a slightly different seed to encourage diversity.
    Returns a list of candidate response strings.
    """
    if n < 1:
        n = 1

    seed = base_seed if base_seed is not None else random.randint(0, _MAX_SEED)
    candidates: list[str] = []

    for i in range(n):
        candidate_seed = seed + i
        text = await generate_single(
            llm,
            messages,
            temperature=base_temperature,
            max_tokens=max_tokens,
            seed=candidate_seed,
            extra_params=extra_params,
        )
        if text:
            candidates.append(text)

    return candidates


async def self_refine(
    llm: LLMClient,
    *,
    char_name: str,
    writing_style: str,
    boundaries: str,
    world_state_block: str,
    memory_lines_text: str,
    user_message: str,
    best_candidate_text: str,
    rewrite_suggestion: str,
    max_tokens: int = 1024,
    extra_params: dict[str, Any] | None = None,
) -> str:
    """Run a self-refine pass on the best candidate using the judge's suggestion.

    Returns the refined text, or the original *best_candidate_text* on failure.
    """
    if not rewrite_suggestion:
        return best_candidate_text

    messages = build_refine_prompt(
        char_name=char_name,
        writing_style=writing_style,
        boundaries=boundaries,
        world_state_block=world_state_block,
        memory_lines_text=memory_lines_text,
        user_message=user_message,
        best_candidate_text=best_candidate_text,
        rewrite_suggestion=rewrite_suggestion,
    )

    try:
        refine_params: dict[str, Any] = {"temperature": 0.5, "max_tokens": max_tokens}
        if extra_params:
            refine_params.update(extra_params)
            refine_params["temperature"] = 0.5  # keep deterministic for refine
        response = await llm.chat_completion(messages, **refine_params)
        refined = (
            response.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        return refined if refined else best_candidate_text
    except Exception:
        logger.exception("Self-refine failed — keeping original candidate")
        return best_candidate_text


async def run_pipeline(
    chat_llm: LLMClient,
    judge_llm: LLMClient | None,
    messages: list[dict[str, str]],
    *,
    best_of_n: int = 1,
    do_self_refine: bool = False,
    char_name: str = "",
    writing_style: str = "",
    boundaries: str = "",
    world_state_json: str = "{}",
    world_state_block: str = "",
    memory_lines_text: str = "",
    user_message: str = "",
    base_temperature: float = 0.7,
    max_tokens: int = 1024,
    base_seed: int | None = None,
    extra_params: dict[str, Any] | None = None,
) -> tuple[str, JudgeResult | None]:
    """Run the full generation pipeline: generate → judge → refine.

    Returns ``(final_text, judge_result_or_None)``.

    - If *best_of_n* is 1 and *do_self_refine* is False, this is equivalent
      to a simple single-shot generation (no judge call).
    - If *judge_llm* is None, the first candidate is returned without scoring.
    """
    # Step 1: generate candidates
    if best_of_n <= 1:
        text = await generate_single(
            chat_llm,
            messages,
            temperature=base_temperature,
            max_tokens=max_tokens,
            seed=base_seed,
            extra_params=extra_params,
        )
        if not text:
            return ("", None)

        # If self-refine without judge, skip refine (no suggestion available)
        if not do_self_refine or judge_llm is None:
            return (text, None)

        # Single candidate with self-refine: ask judge for suggestion only
        candidates = [text]
    else:
        candidates = await generate_best_of_n(
            chat_llm,
            messages,
            n=best_of_n,
            base_temperature=base_temperature,
            max_tokens=max_tokens,
            base_seed=base_seed,
            extra_params=extra_params,
        )
        if not candidates:
            return ("", None)

    # Step 2: judge evaluation
    if judge_llm is None:
        return (candidates[0], None)

    judge_result = await evaluate_candidates(
        judge_llm,
        char_name=char_name,
        writing_style=writing_style,
        boundaries=boundaries,
        world_state_json=world_state_json,
        memory_lines_text=memory_lines_text,
        user_message=user_message,
        candidates=candidates,
    )

    # Select the best candidate
    labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    best_idx = 0
    if judge_result.best_id:
        for i, label in enumerate(labels[: len(candidates)]):
            if label == judge_result.best_id:
                best_idx = i
                break

    best_text = candidates[best_idx] if best_idx < len(candidates) else candidates[0]

    # Step 3: self-refine
    if do_self_refine and judge_result.rewrite_suggestion:
        best_text = await self_refine(
            chat_llm,
            char_name=char_name,
            writing_style=writing_style,
            boundaries=boundaries,
            world_state_block=world_state_block,
            memory_lines_text=memory_lines_text,
            user_message=user_message,
            best_candidate_text=best_text,
            rewrite_suggestion=judge_result.rewrite_suggestion,
            max_tokens=max_tokens,
            extra_params=extra_params,
        )

    return (best_text, judge_result)
