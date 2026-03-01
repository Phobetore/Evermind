"""Prompt assembler — builds the final prompt for chat generation.

Follows Addendum v1.1 §C.7 assembly order:
  1. System (C.1)
  2. Controller (C.2)
  3. Character Core (C.3)
  4. World State (C.4)
  5. Memory (C.5)
  6. Recent chat (C.6)
  7. User message
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.prompting.templates import (
    CHARACTER_CORE,
    CONTROLLER,
    JUDGE,
    MEMORY_BLOCK,
    PRODUCT_NAME,
    RECENT_CHAT,
    SELF_REFINE,
    SYSTEM_RP,
    USER_PERSONA,
    WORLD_STATE,
)

if TYPE_CHECKING:
    from app.models.character import CharacterResponse
    from app.models.memory import MemoryResponse
    from app.models.message import MessageResponse
    from app.models.user_persona import UserPersonaResponse


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


def _format_world_state(world_state: dict[str, Any] | None) -> str:
    """Render the world state block from a state dict, or return empty string."""
    if not world_state:
        return ""
    return WORLD_STATE.format(
        world_location=world_state.get("location", "(unknown)"),
        world_relationship_state=world_state.get("relationship_state", "(unknown)"),
        world_active_goals=world_state.get("active_goals", "(none)"),
        world_open_threads=world_state.get("open_threads", "(none)"),
        world_inventory=world_state.get("inventory", "(none)"),
        world_notes=world_state.get("notes", "(none)"),
    )


def _format_memory_lines(memories: list[MemoryResponse]) -> str:
    """Render memory items as one-line summaries for the memory block."""
    if not memories:
        return ""
    lines: list[str] = []
    for m in memories:
        imp = f"{m.importance:.2f}"
        conf = f"{m.confidence:.2f}"
        lines.append(f"- [{m.type}|imp={imp}|conf={conf}] {m.content}")
    return MEMORY_BLOCK.format(memory_lines="\n".join(lines))


def _format_user_persona(persona: UserPersonaResponse) -> str:
    """Render the user persona block, or return empty string."""
    return USER_PERSONA.format(
        persona_name=persona.name or "(unknown)",
        persona_age=persona.age or "(unspecified)",
        persona_physical_description=persona.physical_description or "(unspecified)",
        persona_personality=persona.personality or "(unspecified)",
        persona_backstory=persona.backstory or "(unspecified)",
        persona_notes=persona.notes or "(none)",
    )


def build_chat_messages(
    character: CharacterResponse,
    recent_messages: list[MessageResponse],
    user_message: str,
    *,
    world_state: dict[str, Any] | None = None,
    memories: list[MemoryResponse] | None = None,
    user_persona: UserPersonaResponse | None = None,
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

    world_state_text = _format_world_state(world_state)
    memory_text = _format_memory_lines(memories or [])
    persona_text = _format_user_persona(user_persona) if user_persona else ""

    recent_text = ""
    if recent_messages:
        recent_text = RECENT_CHAT.format(
            recent_messages=_format_recent_messages(character.name, recent_messages),
        )

    # Assemble per §C.7: system → controller → core → persona → world → memory → history
    system_parts = [system_text, controller_text, core_text]
    if persona_text:
        system_parts.append(persona_text)
    if world_state_text:
        system_parts.append(world_state_text)
    if memory_text:
        system_parts.append(memory_text)
    if recent_text:
        system_parts.append(recent_text)
    full_system = "\n\n".join(system_parts)

    return [
        {"role": "system", "content": full_system},
        {"role": "user", "content": user_message},
    ]


def _format_candidates(candidates: list[str]) -> str:
    """Render numbered candidates (A, B, C …) for the judge prompt."""
    labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    lines: list[str] = []
    for i, text in enumerate(candidates):
        label = labels[i] if i < len(labels) else str(i)
        lines.append(f"{label}) {text}")
    return "\n".join(lines)


def build_judge_prompt(
    char_name: str,
    writing_style: str,
    boundaries: str,
    world_state_json: str,
    memory_lines_text: str,
    user_message: str,
    candidates: list[str],
) -> list[dict[str, str]]:
    """Build the OpenAI-compatible messages list for the judge LLM.

    Returns a list of ``{"role": "system", "content": …}`` dicts.
    """
    prompt = JUDGE.format(
        char_name=char_name,
        char_writing_style=writing_style or "(default)",
        boundaries_text=boundaries or "(none)",
        world_state_json=world_state_json or "{}",
        memory_lines=memory_lines_text or "(none)",
        user_message=user_message,
        candidates_text=_format_candidates(candidates),
    )
    return [
        {"role": "system", "content": prompt},
        {"role": "user", "content": "Evaluate the candidates and respond with the JSON."},
    ]


def build_refine_prompt(
    char_name: str,
    writing_style: str,
    boundaries: str,
    world_state_block: str,
    memory_lines_text: str,
    user_message: str,
    best_candidate_text: str,
    rewrite_suggestion: str,
) -> list[dict[str, str]]:
    """Build the OpenAI-compatible messages list for the self-refine pass.

    Returns a list of ``{"role": "system", "content": …}`` dicts.
    """
    prompt = SELF_REFINE.format(
        char_name=char_name,
        char_writing_style=writing_style or "(default)",
        boundaries_text=boundaries or "(none)",
        world_state_block=world_state_block or "(none)",
        memory_lines=memory_lines_text or "(none)",
        user_message=user_message,
        best_candidate_text=best_candidate_text,
        rewrite_suggestion=rewrite_suggestion,
    )
    return [
        {"role": "system", "content": prompt},
        {"role": "user", "content": "Write the refined response now."},
    ]
