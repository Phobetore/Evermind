"""Tests for the judge module — parsing and evaluation."""

from __future__ import annotations

import json

from app.chat_orchestrator.judge import CandidateScore, JudgeResult, parse_judge_response


def test_parse_judge_response_valid_json() -> None:
    """A well-formed judge JSON should be parsed correctly."""
    raw = json.dumps(
        {
            "ranking": [
                {
                    "id": "A",
                    "score": 8.5,
                    "subscores": {
                        "persona": 9,
                        "memory": 8,
                        "continuity": 8,
                        "style": 9,
                        "immersion": 9,
                    },
                    "reasons": ["Good persona fidelity", "Solid style"],
                },
                {
                    "id": "B",
                    "score": 7.0,
                    "subscores": {
                        "persona": 7,
                        "memory": 7,
                        "continuity": 7,
                        "style": 7,
                        "immersion": 7,
                    },
                    "reasons": ["Decent but generic"],
                },
            ],
            "best_id": "A",
            "rewrite_suggestion": "Add more emotional depth.",
        }
    )
    result = parse_judge_response(raw)
    assert isinstance(result, JudgeResult)
    assert result.best_id == "A"
    assert result.rewrite_suggestion == "Add more emotional depth."
    assert len(result.ranking) == 2
    assert result.ranking[0].id == "A"
    assert result.ranking[0].score == 8.5
    assert result.ranking[0].subscores["persona"] == 9
    assert result.ranking[1].id == "B"


def test_parse_judge_response_markdown_fenced() -> None:
    """JSON wrapped in markdown fences should be handled."""
    inner = json.dumps({"ranking": [], "best_id": "A", "rewrite_suggestion": ""})
    raw = f"```json\n{inner}\n```"
    result = parse_judge_response(raw)
    assert result.best_id == "A"
    assert result.ranking == []


def test_parse_judge_response_invalid_json() -> None:
    """Invalid JSON should produce an empty result without crashing."""
    result = parse_judge_response("not valid json {{{")
    assert isinstance(result, JudgeResult)
    assert result.best_id == ""
    assert result.ranking == []
    assert result.rewrite_suggestion == ""


def test_parse_judge_response_non_dict() -> None:
    """A JSON array instead of object should produce an empty result."""
    result = parse_judge_response("[1, 2, 3]")
    assert result.best_id == ""


def test_parse_judge_response_empty_string() -> None:
    """Empty string should produce an empty result."""
    result = parse_judge_response("")
    assert result.best_id == ""


def test_candidate_score_defaults() -> None:
    """CandidateScore should have sensible defaults."""
    cs = CandidateScore(id="X")
    assert cs.score == 0.0
    assert cs.subscores == {}
    assert cs.reasons == []


def test_parse_judge_response_non_numeric_score() -> None:
    """Non-numeric score values should not crash — default to 0.0."""
    raw = json.dumps(
        {
            "ranking": [{"id": "A", "score": "not_a_number", "subscores": {}, "reasons": []}],
            "best_id": "A",
            "rewrite_suggestion": "",
        }
    )
    result = parse_judge_response(raw)
    assert len(result.ranking) == 1
    assert result.ranking[0].score == 0.0
