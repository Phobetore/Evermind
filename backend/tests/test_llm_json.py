"""Repair-parser tests: the ways RP models actually break JSON."""

from app.services.llm_json import parse_llm_json


def test_strict_json():
    assert parse_llm_json('{"a": 1}') == {"a": 1}


def test_literal_newlines_inside_strings():
    text = '{"greeting": "*The rain falls.*\nYou are here, {{user}}.\n\nCome closer.", "name": "Kenji"}'
    parsed = parse_llm_json(text)
    assert parsed is not None
    assert parsed["name"] == "Kenji"
    assert "The rain falls" in parsed["greeting"]
    assert "\n" in parsed["greeting"]  # newlines preserved as real newlines


def test_markdown_fence():
    text = 'Here is the card:\n```json\n{"name": "Kenji"}\n```\nThere you go!'
    assert parse_llm_json(text) == {"name": "Kenji"}


def test_prose_before_and_after_with_braces():
    text = 'Of course! {"name": "Kenji", "tags": ["yakuza"]} I hope this works {really}.'
    assert parse_llm_json(text) == {"name": "Kenji", "tags": ["yakuza"]}


def test_trailing_commas():
    text = '{"name": "Kenji", "tags": ["a", "b",],}'
    assert parse_llm_json(text) == {"name": "Kenji", "tags": ["a", "b"]}


def test_fence_with_newlines_and_trailing_comma():
    text = '```json\n{\n  "name": "Kenji",\n  "greeting": "Ligne 1\nLigne 2",\n}\n```'
    parsed = parse_llm_json(text)
    assert parsed["name"] == "Kenji"
    assert parsed["greeting"] == "Ligne 1\nLigne 2"


def test_escaped_quotes_survive_repair():
    text = '{"greeting": "Il murmure : \\"reste\\".\nPuis rien."}'
    parsed = parse_llm_json(text)
    assert parsed["greeting"] == 'Il murmure : "reste".\nPuis rien.'


def test_garbage_returns_none():
    assert parse_llm_json("not json du tout") is None
    assert parse_llm_json("") is None
    assert parse_llm_json('["liste", "pas objet"]') is None
