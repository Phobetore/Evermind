"""Tests for memory extraction prompt building and response parsing."""

from __future__ import annotations

from app.memory_pipeline.extractor import build_extraction_prompt, parse_extraction_response


def test_build_extraction_prompt_structure() -> None:
    msgs = build_extraction_prompt(
        char_name="Alice",
        recent_messages_text="User: Hello\nAlice: Hi there!",
        world_state_json='{"location": "forest"}',
    )
    assert len(msgs) == 1
    assert msgs[0]["role"] == "system"
    content = msgs[0]["content"]
    assert "MEMORY EXTRACTOR" in content
    assert "Alice" in content
    assert "Hello" in content
    assert "forest" in content


def test_parse_extraction_response_valid() -> None:
    raw = '{"semantic": [{"title": "t", "content": "c", "tags": [], "importance": 0.5, "confidence": 0.8}], "episodic": [], "world_updates": [], "contradictions": []}'
    result = parse_extraction_response(raw)
    assert len(result["semantic"]) == 1
    assert result["semantic"][0]["title"] == "t"
    assert result["episodic"] == []
    assert result["world_updates"] == []
    assert result["contradictions"] == []


def test_parse_extraction_response_with_markdown_fences() -> None:
    raw = (
        '```json\n{"semantic": [], "episodic": [], "world_updates": [], "contradictions": []}\n```'
    )
    result = parse_extraction_response(raw)
    assert result["semantic"] == []
    assert result["episodic"] == []


def test_parse_extraction_response_invalid_json() -> None:
    result = parse_extraction_response("not json at all")
    assert result == {
        "semantic": [],
        "episodic": [],
        "world_updates": [],
        "contradictions": [],
    }


def test_parse_extraction_response_missing_keys() -> None:
    raw = '{"semantic": [{"title": "x", "content": "y"}]}'
    result = parse_extraction_response(raw)
    assert len(result["semantic"]) == 1
    assert result["episodic"] == []
    assert result["world_updates"] == []
    assert result["contradictions"] == []


def test_parse_extraction_response_non_list_values() -> None:
    raw = '{"semantic": "not a list", "episodic": 42, "world_updates": null, "contradictions": []}'
    result = parse_extraction_response(raw)
    assert result["semantic"] == []
    assert result["episodic"] == []
    assert result["world_updates"] == []
    assert result["contradictions"] == []
