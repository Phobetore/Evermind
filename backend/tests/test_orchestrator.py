"""Tests for the chat orchestrator module — best-of-N, self-refine, pipeline."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app.chat_orchestrator.orchestrator import (
    generate_best_of_n,
    generate_single,
    run_pipeline,
    self_refine,
)


def _mock_llm(content: str = "Hello world") -> AsyncMock:
    """Create a mock LLMClient that returns a fixed chat completion."""
    llm = AsyncMock()
    llm.chat_completion = AsyncMock(
        return_value={"choices": [{"message": {"content": content}}]}
    )
    return llm


def _mock_llm_sequence(contents: list[str]) -> AsyncMock:
    """Create a mock LLMClient that returns different content on each call."""
    llm = AsyncMock()
    llm.chat_completion = AsyncMock(
        side_effect=[
            {"choices": [{"message": {"content": c}}]} for c in contents
        ]
    )
    return llm


@pytest.mark.asyncio
async def test_generate_single_returns_content() -> None:
    llm = _mock_llm("Test response")
    result = await generate_single(llm, [{"role": "user", "content": "Hi"}])
    assert result == "Test response"
    llm.chat_completion.assert_called_once()


@pytest.mark.asyncio
async def test_generate_single_with_seed() -> None:
    llm = _mock_llm("Seeded response")
    result = await generate_single(
        llm, [{"role": "user", "content": "Hi"}], seed=42
    )
    assert result == "Seeded response"
    call_kwargs = llm.chat_completion.call_args
    assert call_kwargs[1]["seed"] == 42


@pytest.mark.asyncio
async def test_generate_single_failure_returns_empty() -> None:
    llm = AsyncMock()
    llm.chat_completion = AsyncMock(side_effect=Exception("LLM down"))
    result = await generate_single(llm, [{"role": "user", "content": "Hi"}])
    assert result == ""


@pytest.mark.asyncio
async def test_generate_best_of_n_returns_n_candidates() -> None:
    llm = _mock_llm_sequence(["Response A", "Response B", "Response C"])
    candidates = await generate_best_of_n(
        llm, [{"role": "user", "content": "Hi"}], n=3
    )
    assert len(candidates) == 3
    assert candidates[0] == "Response A"
    assert candidates[1] == "Response B"
    assert candidates[2] == "Response C"


@pytest.mark.asyncio
async def test_generate_best_of_n_clamps_to_one() -> None:
    llm = _mock_llm("Only one")
    candidates = await generate_best_of_n(
        llm, [{"role": "user", "content": "Hi"}], n=0
    )
    assert len(candidates) == 1


@pytest.mark.asyncio
async def test_self_refine_returns_refined() -> None:
    llm = _mock_llm("Refined response")
    result = await self_refine(
        llm,
        char_name="Alice",
        writing_style="Flowery",
        boundaries="none",
        world_state_block="",
        memory_lines_text="",
        user_message="Hello",
        best_candidate_text="Draft",
        rewrite_suggestion="Add more emotion",
    )
    assert result == "Refined response"


@pytest.mark.asyncio
async def test_self_refine_no_suggestion_returns_original() -> None:
    llm = _mock_llm("Should not be called")
    result = await self_refine(
        llm,
        char_name="Alice",
        writing_style="",
        boundaries="",
        world_state_block="",
        memory_lines_text="",
        user_message="Hello",
        best_candidate_text="Original draft",
        rewrite_suggestion="",
    )
    assert result == "Original draft"
    llm.chat_completion.assert_not_called()


@pytest.mark.asyncio
async def test_self_refine_failure_returns_original() -> None:
    llm = AsyncMock()
    llm.chat_completion = AsyncMock(side_effect=Exception("LLM down"))
    result = await self_refine(
        llm,
        char_name="Alice",
        writing_style="",
        boundaries="",
        world_state_block="",
        memory_lines_text="",
        user_message="Hello",
        best_candidate_text="Original draft",
        rewrite_suggestion="Improve it",
    )
    assert result == "Original draft"


@pytest.mark.asyncio
async def test_run_pipeline_single_shot() -> None:
    """Single generation (best_of_n=1, no refine) returns the LLM output."""
    llm = _mock_llm("Simple response")
    text, judge_result = await run_pipeline(
        llm,
        None,
        [{"role": "user", "content": "Hi"}],
        best_of_n=1,
        do_self_refine=False,
    )
    assert text == "Simple response"
    assert judge_result is None


@pytest.mark.asyncio
async def test_run_pipeline_no_judge_returns_first() -> None:
    """Without a judge LLM, the first candidate is returned."""
    llm = _mock_llm_sequence(["A", "B", "C"])
    text, judge_result = await run_pipeline(
        llm,
        None,
        [{"role": "user", "content": "Hi"}],
        best_of_n=3,
        do_self_refine=False,
    )
    assert text == "A"
    assert judge_result is None


@pytest.mark.asyncio
async def test_generate_single_forwards_extra_params() -> None:
    """Extra params (e.g. frequency_penalty) must be forwarded to the LLM."""
    llm = _mock_llm("Test")
    await generate_single(
        llm,
        [{"role": "user", "content": "Hi"}],
        extra_params={"frequency_penalty": 0.8, "presence_penalty": 0.3},
    )
    call_kwargs = llm.chat_completion.call_args[1]
    assert call_kwargs["frequency_penalty"] == 0.8
    assert call_kwargs["presence_penalty"] == 0.3


@pytest.mark.asyncio
async def test_generate_best_of_n_forwards_extra_params() -> None:
    """Extra params must reach every candidate generation."""
    llm = _mock_llm_sequence(["A", "B"])
    await generate_best_of_n(
        llm,
        [{"role": "user", "content": "Hi"}],
        n=2,
        extra_params={"frequency_penalty": 0.8},
    )
    for call in llm.chat_completion.call_args_list:
        assert call[1]["frequency_penalty"] == 0.8


@pytest.mark.asyncio
async def test_self_refine_forwards_extra_params() -> None:
    """Extra params must be sent during the self-refine LLM call."""
    llm = _mock_llm("Refined")
    await self_refine(
        llm,
        char_name="Alice",
        writing_style="Flowery",
        boundaries="none",
        world_state_block="",
        memory_lines_text="",
        user_message="Hello",
        best_candidate_text="Draft",
        rewrite_suggestion="Add more emotion",
        extra_params={"frequency_penalty": 0.8},
    )
    call_kwargs = llm.chat_completion.call_args[1]
    assert call_kwargs["frequency_penalty"] == 0.8
    # Temperature must stay at 0.5 for self-refine
    assert call_kwargs["temperature"] == 0.5


@pytest.mark.asyncio
async def test_run_pipeline_forwards_extra_params() -> None:
    """Extra params must propagate through the full pipeline."""
    llm = _mock_llm("Response")
    text, _ = await run_pipeline(
        llm,
        None,
        [{"role": "user", "content": "Hi"}],
        best_of_n=1,
        do_self_refine=False,
        extra_params={"frequency_penalty": 0.8},
    )
    assert text == "Response"
    call_kwargs = llm.chat_completion.call_args[1]
    assert call_kwargs["frequency_penalty"] == 0.8
