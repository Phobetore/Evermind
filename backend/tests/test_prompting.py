"""Tests for prompt assembly."""

from __future__ import annotations

from app.models.character import CharacterResponse
from app.models.memory import MemoryResponse
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


def _make_memory(**overrides: object) -> MemoryResponse:
    defaults = {
        "id": "mem1",
        "character_id": "c1",
        "type": "semantic",
        "title": "Likes tea",
        "content": "The user enjoys herbal tea.",
        "entities": ["user"],
        "tags": ["preferences"],
        "importance": 0.7,
        "confidence": 0.9,
        "is_pinned": False,
        "is_deleted": False,
        "created_at": "2026-01-01T00:00:00",
        "last_referenced_at": None,
        "source_turn_id": None,
    }
    defaults.update(overrides)
    return MemoryResponse.model_validate(defaults)


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


def test_build_chat_messages_includes_rp_formatting() -> None:
    """RP formatting rules should be present in the system prompt."""
    char = _make_character()
    msgs = build_chat_messages(char, [], "Hi")
    system_content = msgs[0]["content"]
    assert "RP FORMATTING" in system_content
    assert "*asterisks*" in system_content
    assert "[brackets]" in system_content
    assert "dialogue" in system_content.lower()


def test_build_chat_messages_includes_realistic_reaction_rule() -> None:
    """System prompt must instruct the AI to react realistically to user actions."""
    char = _make_character()
    msgs = build_chat_messages(char, [], "Hi")
    system_content = msgs[0]["content"]
    assert "React realistically" in system_content
    assert "hostile" in system_content.lower()
    assert "violent" in system_content.lower()
    assert "threatening" in system_content.lower()
    # Strengthened: must forbid casual acceptance of physical violence
    assert "casual acceptance" in system_content.lower()
    # Strengthened: must forbid deflecting with pleasantries
    assert "pleasantries" in system_content.lower()


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


def test_build_chat_messages_with_world_state() -> None:
    char = _make_character()
    ws = {
        "location": "The enchanted grove",
        "relationship_state": "friendly acquaintances",
        "active_goals": "Find the lost amulet",
        "open_threads": "Mystery of the disappearing deer",
        "inventory": "Map, lantern",
        "notes": "It is nighttime.",
    }
    msgs = build_chat_messages(char, [], "Where are we?", world_state=ws)
    system_content = msgs[0]["content"]
    assert "WORLD STATE" in system_content
    assert "The enchanted grove" in system_content
    assert "friendly acquaintances" in system_content
    assert "Find the lost amulet" in system_content


def test_build_chat_messages_with_memories() -> None:
    char = _make_character()
    mems = [
        _make_memory(content="The user enjoys herbal tea.", importance=0.7, confidence=0.9),
        _make_memory(
            id="mem2",
            type="episodic",
            content="User visited the river yesterday.",
            importance=0.5,
            confidence=0.8,
        ),
    ]
    msgs = build_chat_messages(char, [], "Hi", memories=mems)
    system_content = msgs[0]["content"]
    assert "MEMORY" in system_content
    assert "herbal tea" in system_content
    assert "river yesterday" in system_content
    assert "[semantic|imp=0.70|conf=0.90]" in system_content
    assert "[episodic|imp=0.50|conf=0.80]" in system_content


def test_build_chat_messages_no_world_state_or_memories() -> None:
    """When no world state or memories, those blocks should be absent."""
    char = _make_character()
    msgs = build_chat_messages(char, [], "Hi")
    system_content = msgs[0]["content"]
    assert "WORLD STATE (current)" not in system_content
    assert "MEMORY (relevant" not in system_content


def test_build_chat_messages_assembly_order() -> None:
    """Verify the C.7 assembly order: system → controller → core → world → memory → history."""
    char = _make_character()
    ws = {
        "location": "TESTLOC",
        "relationship_state": "",
        "active_goals": "",
        "open_threads": "",
        "inventory": "",
        "notes": "",
    }
    mems = [_make_memory(content="TESTMEM")]
    history = [_make_message("user", "TESTHIST")]
    msgs = build_chat_messages(char, history, "Go", world_state=ws, memories=mems)
    system_content = msgs[0]["content"]
    # Check ordering using the unique block headers
    idx_core = system_content.index("CHARACTER CORE")
    idx_world = system_content.index("WORLD STATE (current)")
    idx_memory = system_content.index("MEMORY (relevant")
    idx_recent = system_content.index("RECENT CHAT")
    assert idx_core < idx_world < idx_memory < idx_recent


def test_build_chat_messages_controller_emotional_weight() -> None:
    """Controller should instruct analysis of emotional weight of user actions."""
    char = _make_character()
    msgs = build_chat_messages(char, [], "Hi")
    system_content = msgs[0]["content"]
    assert "emotional weight" in system_content.lower()
    assert "aggressive" in system_content.lower()


def test_build_chat_messages_includes_narrative_style() -> None:
    """System prompt must include narrative style instructions for immersive responses."""
    char = _make_character()
    msgs = build_chat_messages(char, [], "Hi")
    system_content = msgs[0]["content"]
    assert "NARRATIVE STYLE" in system_content
    assert "sensory details" in system_content.lower()
    assert "body language" in system_content.lower()
    assert "multi-paragraph" in system_content.lower()
    assert "immersive" in system_content.lower()


def test_build_chat_messages_controller_immersive_storytelling() -> None:
    """Controller should instruct prioritizing immersive storytelling."""
    char = _make_character()
    msgs = build_chat_messages(char, [], "Hi")
    system_content = msgs[0]["content"]
    assert "immersive storytelling" in system_content.lower()
    assert "vivid narration" in system_content.lower()


def test_build_chat_messages_first_message_suppressed_when_history_exists() -> None:
    """When recent messages exist, the first message in CHARACTER CORE must be
    replaced with a 'do NOT repeat' note so the LLM does not echo it."""
    char = _make_character(first_message="Hello, traveler.")
    history = [
        _make_message("assistant", "Hello, traveler."),
        _make_message("user", "Hi there!"),
    ]
    msgs = build_chat_messages(char, history, "How are you?")
    system_content = msgs[0]["content"]
    # The actual first-message text must NOT appear in CHARACTER CORE
    # (it will still appear in RECENT CHAT via the history messages).
    core_section = system_content.split("RECENT CHAT")[0]
    assert "Hello, traveler." not in core_section
    assert "do NOT repeat" in core_section


def test_build_chat_messages_first_message_shown_when_no_history() -> None:
    """When there is no conversation history yet, the first message must
    remain in CHARACTER CORE for the LLM to use."""
    char = _make_character(first_message="Hello, traveler.")
    msgs = build_chat_messages(char, [], "Hi")
    system_content = msgs[0]["content"]
    assert "Hello, traveler." in system_content


def test_build_chat_messages_no_echo_instruction() -> None:
    """System prompt must instruct the AI to never echo the user's text."""
    char = _make_character()
    msgs = build_chat_messages(char, [], "Hi")
    system_content = msgs[0]["content"]
    assert "never echo" in system_content.lower() or "NEVER echo" in system_content
