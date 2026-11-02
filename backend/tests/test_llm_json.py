"""Repair-parser tests: the ways RP models actually break JSON."""

import math

import pytest

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


# What parity/llm_json.json cannot say: a case file is strict JSON, so it holds no
# NaN, no lone surrogate, nothing as large as these. frontend/src/engine/llmJson.test.ts
# says the same things of the TypeScript twin.


def test_a_reply_nested_beyond_what_the_decoder_follows_is_hopeless_not_a_crash():
    # Far deeper than the decoder's recursion allows on any build: it raises
    # RecursionError, which is not a ValueError and used to end the turn.
    depth = 100_000
    assert parse_llm_json("[" * depth) is None
    assert parse_llm_json("[" * depth + "]" * depth) is None
    assert parse_llm_json('{"a":' * depth + "1" + "}" * depth) is None
    assert parse_llm_json('{"a":' + "[" * depth + "]" * depth + "}") is None


def test_an_object_after_a_nest_too_deep_to_read_is_still_found():
    assert parse_llm_json("[" * 100_000 + ' {"a": 1}') == {"a": 1}
    assert parse_llm_json('{"a": 1} ' + "[" * 100_000) == {"a": 1}


def test_a_nest_as_deep_as_a_card_ever_is_read():
    assert parse_llm_json('{"a":' + "[" * 500 + "]" * 500 + "}") is not None


def test_nan_and_the_infinities_are_read():
    parsed = parse_llm_json('{"a": NaN, "b": Infinity, "c": -Infinity, "d": [NaN, -Infinity]}')
    assert math.isnan(parsed["a"])
    assert parsed["b"] == math.inf
    assert parsed["c"] == -math.inf
    assert math.isnan(parsed["d"][0]) and parsed["d"][1] == -math.inf


@pytest.mark.parametrize("word", ["nan", "NAN", "infinity", "-NaN", "+Infinity", "Inf", "-inf",
                                  "- Infinity", "Infinit"])
def test_other_spellings_of_them_are_not(word):
    assert parse_llm_json(f'{{"a": {word}}}') is None


def test_an_exponent_too_large_for_a_float_is_infinite():
    assert parse_llm_json('{"a": 1e400, "b": -1e400}') == {"a": math.inf, "b": -math.inf}


def test_an_integer_of_4300_digits_is_read_and_of_4301_is_refused():
    # Python refuses to turn more digits than that into an integer.
    assert parse_llm_json(f'{{"a": {"1" * 4300}}}') == {"a": int("1" * 4300)}
    assert parse_llm_json(f'{{"a": -{"1" * 4300}}}') is not None
    assert parse_llm_json(f'{{"a": {"1" * 4301}}}') is None
    assert parse_llm_json(f'{{"a": -{"1" * 4301}}}') is None
    # Not an integer: no limit.
    assert parse_llm_json(f'{{"a": {"1" * 5000}.5}}') is not None
    assert parse_llm_json(f'{{"a": {"1" * 5000}e1}}') is not None


def test_an_integer_has_no_minus_zero_and_a_float_has():
    assert str(parse_llm_json('{"a": -0}')["a"]) == "0"
    assert math.copysign(1, parse_llm_json('{"a": -0.0}')["a"]) == -1
    assert math.copysign(1, parse_llm_json('{"a": -0e1}')["a"]) == -1


def test_a_surrogate_pair_is_one_character_and_a_lone_surrogate_stays():
    assert parse_llm_json('{"a": "\\ud83d\\ude00"}')["a"] == "\N{GRINNING FACE}"
    assert parse_llm_json('{"a": "\\ud83d"}')["a"] == chr(0xD83D)
    assert parse_llm_json('{"a": "\\ude00"}')["a"] == chr(0xDE00)
    assert parse_llm_json('{"a": "\\ud83d\\u0041"}')["a"] == chr(0xD83D) + "A"
    assert parse_llm_json('{"a": "\\ud83d\\ud83d\\ude00"}')["a"] == chr(0xD83D) + "\N{GRINNING FACE}"
    assert parse_llm_json('{"a": "\\ude00\\ud83d"}')["a"] == chr(0xDE00) + chr(0xD83D)
    assert parse_llm_json('{"a": "\\ud83d\\u00g0"}') is None


def test_the_four_digits_of_an_escape_are_hexadecimal_and_nothing_else():
    arabic_indic = "".join(chr(0x660 + digit) for digit in (0, 0, 4, 1))
    for digits in ["0x41", "+041", "-041", " 041", "04 1", "4.1e", "00_1", arabic_indic]:
        assert parse_llm_json(f'{{"a": "\\u{digits}"}}') is None, digits
    assert parse_llm_json('{"a": "\\u00Ab\\u00aB"}')["a"] == chr(0xAB) * 2


def test_control_characters_are_refused_inside_a_string_but_three_are_repaired():
    for code in (0x00, 0x08, 0x0B, 0x0C, 0x1F):
        assert parse_llm_json(f'{{"a": "x{chr(code)}y"}}') is None, code
    for code in (0x09, 0x0A, 0x0D):
        assert parse_llm_json(f'{{"a": "x{chr(code)}y"}}') == {"a": f"x{chr(code)}y"}
    assert parse_llm_json('{"a": "x\x7fy"}')["a"] == "x\x7fy"


def test_a_key_named_proto_is_a_key():
    parsed = parse_llm_json('{"__proto__": {"polluted": true}, "a": 1}')
    assert parsed == {"__proto__": {"polluted": True}, "a": 1}
    assert list(parsed) == ["__proto__", "a"]


def test_the_last_of_two_equal_keys_wins_where_the_first_one_stood():
    assert list(parse_llm_json('{"a": 1, "b": 2, "a": 3}').items()) == [("a", 3), ("b", 2)]
