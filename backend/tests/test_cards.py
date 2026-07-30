"""Character Card V2 codec tests (JSON structure + PNG chara chunk)."""

import base64
import json
import struct
import zlib

from app.cards.codec import card_to_character, character_to_card
from app.cards.png import read_card_from_png, write_card_to_png

CHAR_FIELDS = {
    "kind": "character",
    "name": "Serana",
    "tagline": "Vampire lady of the ruins",
    "description": "A centuries-old vampire noble.",
    "personality": "wry, guarded, loyal",
    "scenario": "You found her in a sealed crypt.",
    "greeting": "*She looks up.* Who... are you?",
    "alternate_greetings": ["*She hisses.* Stay back!"],
    "example_dialogues": "<START>\n{{user}}: Hi\n{{char}}: *nods* Hello.",
    "system_prompt": "",
    "post_history_instructions": "",
    "creator_notes": "Test card",
    "tags": ["fantasy", "vampire"],
    "creator": "tester",
    "character_version": "1.0",
}


def make_minimal_png() -> bytes:
    """Build a valid 1x1 grayscale PNG with stdlib only."""

    def chunk(ctype: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + ctype
            + data
            + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 0, 0, 0, 0)
    idat = zlib.compress(b"\x00\x00")
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )


def test_character_to_card_shape():
    card = character_to_card(CHAR_FIELDS)
    assert card["spec"] == "chara_card_v2"
    assert card["spec_version"] == "2.0"
    d = card["data"]
    assert d["name"] == "Serana"
    assert d["first_mes"] == CHAR_FIELDS["greeting"]
    assert d["mes_example"] == CHAR_FIELDS["example_dialogues"]
    assert d["alternate_greetings"] == CHAR_FIELDS["alternate_greetings"]
    assert d["tags"] == ["fantasy", "vampire"]
    assert d["extensions"]["evermind"]["kind"] == "character"
    assert d["extensions"]["evermind"]["tagline"] == CHAR_FIELDS["tagline"]


def test_card_round_trip():
    card = character_to_card(CHAR_FIELDS)
    back = card_to_character(card)
    assert back == CHAR_FIELDS


def test_card_to_character_v1_flat():
    v1 = {
        "name": "Old Card",
        "description": "desc",
        "personality": "grumpy",
        "scenario": "an inn",
        "first_mes": "Hello there.",
        "mes_example": "<START>\n{{char}}: Hi",
    }
    char = card_to_character(v1)
    assert char["name"] == "Old Card"
    assert char["greeting"] == "Hello there."
    assert char["example_dialogues"] == "<START>\n{{char}}: Hi"
    assert char["kind"] == "character"
    assert char["tags"] == []


def test_card_to_character_missing_name_defaults():
    char = card_to_character({"data": {"description": "x"}})
    assert char["name"] == "Unnamed"


def test_png_round_trip():
    png = make_minimal_png()
    card = character_to_card(CHAR_FIELDS)
    out = write_card_to_png(png, card)
    # still a valid PNG signature, ends with IEND
    assert out.startswith(b"\x89PNG\r\n\x1a\n")
    assert out.rstrip().endswith(b"IEND" + struct.pack(">I", zlib.crc32(b"IEND") & 0xFFFFFFFF))
    read = read_card_from_png(out)
    assert read == card


def test_png_write_replaces_existing_card():
    png = make_minimal_png()
    first = write_card_to_png(png, character_to_card(CHAR_FIELDS))
    other = dict(CHAR_FIELDS, name="Other")
    second = write_card_to_png(first, character_to_card(other))
    read = read_card_from_png(second)
    assert read["data"]["name"] == "Other"
    # only one chara chunk remains
    assert second.count(b"chara\x00") == 1


def test_png_without_card_returns_none():
    assert read_card_from_png(make_minimal_png()) is None


def test_png_with_legacy_base64_json():
    """Some tools store the card as raw base64 JSON in the tEXt chunk."""
    png = make_minimal_png()
    payload = base64.b64encode(json.dumps({"name": "Legacy", "first_mes": "hi"}).encode())

    def chunk(ctype: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + ctype
            + data
            + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF)
        )

    text_chunk = chunk(b"tEXt", b"chara\x00" + payload)
    patched = png[:-12] + text_chunk + png[-12:]
    card = read_card_from_png(patched)
    assert card["name"] == "Legacy"
