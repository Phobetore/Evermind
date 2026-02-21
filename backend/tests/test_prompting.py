"""Tests for prompt assembly."""

from __future__ import annotations

from app.models.character import CharacterResponse
from app.models.message import MessageResponse
from app.prompting.assembler import build_chat_messages


def _make_character(**overrides: object) -> CharacterResponse:
    defaults = {
        "id": "c1",
        "name": "Alice",
        "tags": ["fantasy", "kind"],
        "summary": "A kind elf.",
        "persona": "Gentle and wise.",
        "writing_style": "Flowery prose.",
        "scenario": "In a magical forest.",
        "first_message": "Hello, traveler.",
        "example_dialogues": [{"user": "Hi", "assistant": "Greetings!"}],
        "boundaries": "No violence.",
        "system_rules": "",
        "memory_seed": [],
        "created_at": "2026-01-01T00:00:00",
        "updated_at": "2026-01-01T00:00:00",
    }
    defaults.update(overrides)
    return CharacterResponse.model_validate(defaults)


def _make_message(role: str, content: str) -> MessageResponse:
    return MessageResponse(
        id="m1",
        conversation_id="conv1",
        role=role,
        content=content,
        created_at="2026-01-01T00:00:00",
        meta={},
    )


def test_build_chat_messages_basic() -> None:
    char = _make_character()
    msgs = build_chat_messages(char, [], "Hello!")
    assert len(msgs) == 2
    assert msgs[0]["role"] == "system"
    assert msgs[1]["role"] == "user"
    assert msgs[1]["content"] == "Hello!"
    # System message should contain character name
    assert "Alice" in msgs[0]["content"]
    assert "CHARACTER CORE" in msgs[0]["content"]
    assert "CONTROLLER" in msgs[0]["content"]


def test_build_chat_messages_with_history() -> None:
    char = _make_character()
    history = [
        _make_message("user", "Hi there"),
        _make_message("assistant", "Hello, kind soul!"),
    ]
    msgs = build_chat_messages(char, history, "How are you?")
    system_content = msgs[0]["content"]
    assert "RECENT CHAT" in system_content
    assert "Hi there" in system_content
    assert "Hello, kind soul!" in system_content


def test_build_chat_messages_includes_boundaries() -> None:
    char = _make_character(boundaries="No dark themes")
    msgs = build_chat_messages(char, [], "Hi")
    assert "No dark themes" in msgs[0]["content"]


def test_build_chat_messages_includes_tags() -> None:
    char = _make_character(tags=["sci-fi", "witty"])
    msgs = build_chat_messages(char, [], "Hi")
    assert "sci-fi, witty" in msgs[0]["content"]
