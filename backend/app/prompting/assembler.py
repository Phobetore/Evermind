"""Prompt assembler — builds the final prompt for chat generation.

Follows Addendum v1.1 §C.7 assembly order:
  1. System (C.1)
  2. Controller (C.2)
  3. Character Core (C.3)
  4. Recent chat (C.6)
  5. User message
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.prompting.templates import (
    CHARACTER_CORE,
    CONTROLLER,
    PRODUCT_NAME,
    RECENT_CHAT,
    SYSTEM_RP,
)

if TYPE_CHECKING:
    from app.models.character import CharacterResponse
    from app.models.message import MessageResponse


def _format_example_dialogues(
    char_name: str,
    dialogues: list[dict[str, str]],
) -> str:
    """Render example dialogues as User: … / CharName: … pairs."""
    if not dialogues:
        return "(none)"
    lines: list[str] = []
    for d in dialogues:
        lines.append(f"User: {d.get('user', '')}")
        lines.append(f"{char_name}: {d.get('assistant', '')}")
    return "\n".join(lines)


def _format_recent_messages(
    char_name: str,
    messages: list[MessageResponse],
) -> str:
    """Render recent messages as User: … / CharName: … lines."""
    lines: list[str] = []
    for m in messages:
        if m.role == "user":
            lines.append(f"User: {m.content}")
        elif m.role == "assistant":
            lines.append(f"{char_name}: {m.content}")
    return "\n".join(lines)


def build_chat_messages(
    character: CharacterResponse,
    recent_messages: list[MessageResponse],
    user_message: str,
) -> list[dict[str, str]]:
    """Build the OpenAI-compatible messages list for chat completion.

    Returns a list of ``{"role": …, "content": …}`` dicts suitable for
    the ``/v1/chat/completions`` API.
    """
    boundaries = character.boundaries or "(none specified)"
    example_dialogues_text = _format_example_dialogues(
        character.name,
        [d.model_dump() if hasattr(d, "model_dump") else d for d in character.example_dialogues],
    )

    system_text = SYSTEM_RP.format(
        product_name=PRODUCT_NAME,
        char_name=character.name,
        boundaries_text=boundaries,
    )

    controller_text = CONTROLLER

    core_text = CHARACTER_CORE.format(
        char_name=character.name,
        char_tags_csv=", ".join(character.tags) if character.tags else "(none)",
        char_summary=character.summary or "(none)",
        char_persona=character.persona or "(none)",
        char_writing_style=character.writing_style or "(default)",
        char_scenario=character.scenario or "(none)",
        char_system_rules=character.system_rules or "(none)",
        boundaries_text=boundaries,
        char_first_message=character.first_message or "(none)",
        char_example_dialogues=example_dialogues_text,
    )

    recent_text = ""
    if recent_messages:
        recent_text = RECENT_CHAT.format(
            recent_messages=_format_recent_messages(character.name, recent_messages),
        )

    # Assemble the system message (system + controller + core + history)
    system_parts = [system_text, controller_text, core_text]
    if recent_text:
        system_parts.append(recent_text)
    full_system = "\n\n".join(system_parts)

    return [
        {"role": "system", "content": full_system},
        {"role": "user", "content": user_message},
    ]
