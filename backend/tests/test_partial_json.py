"""Reading the fields of a card that is not finished: an answer read while it arrives, or one the
model stopped short. Whatever it gives must be what the whole answer says."""

import json
import random

import pytest

from app.services.llm_json import parse_llm_json, partial_json

LORE = [
    {"keys": ["Kabukicho", "歌舞伎町"], "content": "The red-light district. {Neon} and [rain]."},
    {"keys": ["clan Sato"], "content": "The family that runs the docks.\nThey say \"never\"."},
    {"keys": ["the ledger"], "content": "A book of debts, with nested {braces {inside}}."},
    {"keys": ["Mei 🐉"], "content": "Kenji's sister, who keeps a dragon tattoo 🐉."},
]

CARD = {
    "name": "Kenji \"the Knife\" Sato",
    "tagline": "Il ne rit jamais : {jamais}.",
    "description": "Line one.\nLine two, with a backslash \\ and a quote \".",
    "personality": "cold, loyal, [guarded]",
    "scenario": "{{user}} owes the clan money.",
    "greeting": "*Rain falls.* So, {{user}}… 雨だ。 🌧️",
    "alternate_greetings": ["*The bar is empty.*", "*He waits, [arms crossed].*"],
    "example_dialogues": "<START>\n{{user}}: Hi.\n{{char}}: \"Hi\" yourself.",
    "tags": ["yakuza", "noir"],
    "version": 27,
    "extra": {"nested": {"deep": [1, 2, {"x": "}"}]}, "flag": True, "none": None},
    "lore_entries": LORE,
}

MESSY = ('Voici votre fiche :\n```json\n{\n"name": "Kenji Sato",\n'
         '"greeting": "*Rain falls on Kabukicho.*\nTu n\'es personne, {{user}}.",\n'
         '"tags": ["yakuza", "realistic",],\n'
         '"lore_entries": [\n  {"keys": ["Kabukicho"], "content": "Neon\nand rain."},\n'
         '  {"keys": ["docks"], "content": "Salt."},\n],\n}\n```\nHave a good game!')

ANSWERS = {
    "compact": json.dumps(CARD),
    "indented, not escaped": json.dumps(CARD, ensure_ascii=False, indent=2),
    "after a thought": "<think>Plan: name {first}.</think>\n" + json.dumps(CARD, ensure_ascii=False),
    "in a fence, with chatter and literal newlines": MESSY,
    "lore first": json.dumps({"lore_entries": LORE, "name": "Mei"}, ensure_ascii=False, indent=1),
}


@pytest.mark.parametrize("answer", ANSWERS.values(), ids=ANSWERS.keys())
def test_a_whole_answer_gives_what_parse_llm_json_gives(answer):
    whole = parse_llm_json(answer)
    assert whole is not None
    assert partial_json(answer) == (whole, None)


@pytest.mark.parametrize("answer", ANSWERS.values(), ids=ANSWERS.keys())
def test_every_field_of_an_answer_cut_anywhere_is_as_the_whole_says(answer):
    whole = parse_llm_json(answer)
    seen: list[str] = []
    for n in range(len(answer) + 1):
        fields, writing = partial_json(answer[:n])
        assert writing is None or writing in whole, (n, writing)
        for key, value in fields.items():
            if isinstance(whole[key], list) and key == writing:
                assert value == whole[key][:len(value)], (n, key)
            else:
                assert value == whole[key], (n, key)
        done = [key for key in fields if key != writing]
        # A field once whole stays whole, and the fields come in the order they were written.
        assert done[:len(seen)] == seen, n
        seen = done
    assert seen == list(whole)


def test_a_list_being_written_gives_the_elements_it_has_finished():
    answer = json.dumps(CARD, ensure_ascii=False)
    cut = answer[:answer.index('"Mei')]
    fields, writing = partial_json(cut)
    assert writing == "lore_entries"
    assert fields["lore_entries"] == LORE[:3]
    assert fields["tags"] == ["yakuza", "noir"]


def test_a_number_is_whole_only_once_something_follows_it():
    assert partial_json('{"name": "Nyra", "version": 2') == ({"name": "Nyra"}, "version")
    assert partial_json('{"name": "Nyra", "version": 27,') == ({"name": "Nyra", "version": 27}, None)


@pytest.mark.parametrize(("text", "expected"), [
    ("", ({}, None)),
    ("Sorry, I cannot.", ({}, None)),
    ("<think>Let me see. {", ({}, None)),
    ('{"name": "Ny', ({}, "name")),
    ('{"name"', ({}, "name")),
    ('{"name": ', ({}, "name")),
    ('{"na', ({}, None)),
    ('{"name": "Nyra",\n', ({"name": "Nyra"}, None)),
    ('{"name": "Nyra", "tags": ["a", "b', ({"name": "Nyra", "tags": ["a"]}, "tags")),
    # A comma forgotten between two fields costs no field of a card that was not readable anyway.
    ('{"name": "Nyra" "tags": ["a"]}', ({"name": "Nyra", "tags": ["a"]}, None)),
    ('{"name": "Nyra", 5: "x", "tags": []}', ({"name": "Nyra"}, None)),
    ('{"name": "Nyra", "bad": [1, 2}', ({"name": "Nyra"}, None)),
])
def test_what_a_cut_answer_holds(text, expected):
    assert partial_json(text) == expected


def test_it_never_raises_whatever_the_text():
    rng = random.Random(7)
    alphabet = '{}[]",:\\ntrue false null 0123456789.-eE\n\t é🐉<think></think>```'
    for _ in range(3000):
        text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 60)))
        fields, writing = partial_json(text)
        assert isinstance(fields, dict) and (writing is None or isinstance(writing, str))
    for text in ("[" * 100_000, '{"a": ' + "[" * 100_000, '{"a": ' + "[" * 100_000 + "]" * 100_000):
        assert isinstance(partial_json(text)[0], dict)
