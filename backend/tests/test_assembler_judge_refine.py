"""Tests for the judge and refine prompt assembler helpers."""

from __future__ import annotations

from app.prompting.assembler import build_judge_prompt, build_refine_prompt


def test_build_judge_prompt_structure() -> None:
    """Judge prompt should contain all provided context."""
    msgs = build_judge_prompt(
        char_name="Alice",
        writing_style="Flowery prose",
        boundaries="No violence",
        world_state_json='{"location": "forest"}',
        memory_lines_text="- [semantic] Likes tea",
        user_message="Hello!",
        candidates=["Response A", "Response B"],
    )
    assert len(msgs) == 2
    assert msgs[0]["role"] == "system"
    assert msgs[1]["role"] == "user"
    content = msgs[0]["content"]
    assert "Alice" in content
    assert "Flowery prose" in content
    assert "No violence" in content
    assert "forest" in content
    assert "Likes tea" in content
    assert "Hello!" in content
    assert "A) Response A" in content
    assert "B) Response B" in content
    assert "JUDGE" in content
    # Reaction realism must be a scoring criterion
    assert "Reaction realism" in content
    assert "reaction" in content.lower()


def test_build_judge_prompt_many_candidates() -> None:
    """Should handle more than 2 candidates."""
    candidates = [f"Candidate {i}" for i in range(5)]
    msgs = build_judge_prompt(
        char_name="Bob",
        writing_style="",
        boundaries="",
        world_state_json="{}",
        memory_lines_text="",
        user_message="Test",
        candidates=candidates,
    )
    content = msgs[0]["content"]
    assert "A) Candidate 0" in content
    assert "E) Candidate 4" in content


def test_build_refine_prompt_structure() -> None:
    """Refine prompt should contain all the required elements."""
    msgs = build_refine_prompt(
        char_name="Alice",
        writing_style="Flowery prose",
        boundaries="No violence",
        world_state_block="WORLD STATE...",
        memory_lines_text="- [semantic] Likes tea",
        user_message="Hello!",
        best_candidate_text="Original draft text",
        rewrite_suggestion="Add more emotional depth",
    )
    assert len(msgs) == 2
    assert msgs[0]["role"] == "system"
    assert msgs[1]["role"] == "user"
    content = msgs[0]["content"]
    assert "Alice" in content
    assert "Flowery prose" in content
    assert "Original draft text" in content
    assert "Add more emotional depth" in content
    assert "SELF-REFINE" in content


def test_build_refine_prompt_defaults() -> None:
    """Empty optional fields should use defaults."""
    msgs = build_refine_prompt(
        char_name="Test",
        writing_style="",
        boundaries="",
        world_state_block="",
        memory_lines_text="",
        user_message="Hi",
        best_candidate_text="Draft",
        rewrite_suggestion="Fix it",
    )
    content = msgs[0]["content"]
    assert "(default)" in content
    assert "(none)" in content


def test_build_judge_prompt_narrative_richness_criterion() -> None:
    """Judge prompt should include narrative richness as a scoring criterion."""
    msgs = build_judge_prompt(
        char_name="Alice",
        writing_style="Flowery prose",
        boundaries="No violence",
        world_state_json="{}",
        memory_lines_text="",
        user_message="Hello!",
        candidates=["Response A"],
    )
    content = msgs[0]["content"]
    assert "Narrative richness" in content
    assert "narrative" in content.lower()
    assert '"narrative":0' in content or '"narrative": 0' in content
