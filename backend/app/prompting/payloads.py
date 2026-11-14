"""The prompts that are not a chat turn's: ghost-writing the player's next message,
extracting and consolidating the memory, and drafting a card. Pure: no database, no model.
"""

import json

from .defaults import (
    CARD_ASSISTANT_PROMPT,
    IMPERSONATE_PROMPT,
    MEMORY_CONSOLIDATION_PROMPT,
    MEMORY_EXTRACTION_PROMPT,
)
from .engine import (
    PromptPayload,
    active_content,
    build_chat_payload,
    is_out_of_character,
    speaking_name,
)
from .macros import substitute
from .memory_changes import MAX_TURNS_PER_RUN, is_movable
from .text import is_writable

MIN_FACTS_TO_CONSOLIDATE = 8  # fewer than this and merging them is not worth a call

TEXT_FIELDS = ("name", "tagline", "description", "personality", "scenario",
               "greeting", "example_dialogues")
LIST_FIELDS = ("alternate_greetings", "tags")


def build_impersonate_payload(character: dict, persona: dict | None, conversation: dict,
                              messages: list[dict], connection: dict) -> PromptPayload:
    """The prompt that ghost-writes the player's next message."""
    char_name = speaking_name(character)
    user_name = (persona or {}).get("name") or "User"
    # Without what the card says to the character among the turns: the player's pen reads no
    # reminder meant for the character.
    base = build_chat_payload(character=character, persona=persona, conversation=conversation,
                              messages=messages, connection=connection, insertions=False)

    context_bits = []
    if (persona or {}).get("description"):
        context_bits.append(f"ABOUT {user_name}: {persona['description']}")
    if (conversation or {}).get("summary"):
        context_bits.append(f"STORY SO FAR: {conversation['summary']}")
    system = substitute(IMPERSONATE_PROMPT, char_name=char_name, user_name=user_name)
    if context_bits:
        system += "\n\n" + "\n\n".join(context_bits)

    # Flip roles: the character's turns become "user", the player's become
    # "assistant", so the model naturally continues as the player.
    flipped = [{"role": "user" if m["role"] == "assistant" else "assistant",
                "content": m["content"]} for m in base.messages]

    return PromptPayload(system=system, messages=flipped, stop=[f"\n{char_name}:"])


def build_extraction_payload(character: dict, persona: dict | None, conversation: dict,
                             messages: list[dict],
                             memories: list[dict]) -> tuple[PromptPayload, list[dict]] | None:
    """The prompt that reads the turns since the last pass for new facts and a new
    summary, and those turns, the newest last. None when there is no turn since.

    A memory position of 0 means nothing was read, so the first turn is one to read, unless
    it is the greeting, which is the card's and not the story's."""
    char_name = speaking_name(character)
    user_name = (persona or {}).get("name") or "User"
    memory_position = conversation.get("memory_position") or 0

    def unread(message: dict) -> bool:
        if message["position"] > memory_position:
            return True
        return (memory_position == 0 and message["position"] == 0
                and not (message.get("meta") or {}).get("greeting"))

    turns = [m for m in messages if unread(m)][-MAX_TURNS_PER_RUN:]
    # What the player said out of character is for the next reply, not a line of the story.
    new_turns = [m for m in turns if not is_out_of_character(m)]
    if not new_turns:
        return None

    facts_block = "\n".join(f"- {m['content']}" for m in memories) or "(none yet)"
    turns_block = "\n\n".join(
        f"{user_name if m['role'] == 'user' else char_name} (turn {m['position']}): "
        + substitute(active_content(m), char_name=char_name, user_name=user_name)
        for m in new_turns
    )

    payload = PromptPayload(
        system=substitute(MEMORY_EXTRACTION_PROMPT, char_name=char_name, user_name=user_name),
        messages=[{
            "role": "user",
            "content": (
                f"CURRENT SUMMARY:\n{conversation.get('summary') or '(empty)'}\n\n"
                f"FACTS ALREADY RECORDED:\n{facts_block}\n\n"
                f"NEWEST TURNS:\n{turns_block}\n\n"
                "Reply with the JSON now."
            ),
        }],
        stop=[],
    )
    return payload, turns


def movable_facts(memories: list[dict]) -> list[dict]:
    """The facts that consolidation may merge: neither pinned nor written by hand."""
    return [m for m in memories if is_movable(m)]


def build_consolidation_payload(character: dict, persona: dict | None,
                                movable: list[dict]) -> PromptPayload:
    """The prompt that merges these facts into a shorter, denser set."""
    char_name = speaking_name(character)
    user_name = (persona or {}).get("name") or "User"
    facts_block = "\n".join(f"- {m['content']}" for m in movable)
    return PromptPayload(
        system=substitute(MEMORY_CONSOLIDATION_PROMPT, char_name=char_name, user_name=user_name),
        messages=[{"role": "user",
                   "content": f"FACTS TO CONSOLIDATE:\n{facts_block}\n\nReply with the JSON now."}],
        stop=[],
    )


def existing_fields(existing: dict | None) -> dict:
    """What the creator has already written, among the fields a card draft fills."""
    return {k: v for k, v in (existing or {}).items()
            if isinstance(v, (str, list)) and v and k in TEXT_FIELDS + LIST_FIELDS}


def words(value: object) -> list[str]:
    """The words of what stands for a list: each element that is text or a whole number,
    stripped, a bare string being a list of one. A lone surrogate cannot be written back: no word."""
    items = value if isinstance(value, list) else [value] if isinstance(value, str) else []
    return [w for x in items if type(x) in (str, int) and (w := str(x).strip()) and is_writable(w)]


def build_card_payload(prompt: str, kind: str, existing: dict | None) -> PromptPayload:
    """The prompt that turns a creator's brief into a card draft."""
    kind_line = (
        "The card is a SCENARIO (the AI narrates the world and plays every character except the player)."
        if kind == "scenario"
        else "The card is a CHARACTER (the AI embodies one person the player talks to)."
    )
    existing_filled = existing_fields(existing)
    parts = [f"{kind_line}\n\nCREATOR'S BRIEF:\n{prompt.strip()}"]
    if existing_filled:
        parts.append("EXISTING FIELDS (keep their content, fill the rest):\n"
                     + json.dumps(existing_filled, ensure_ascii=False, indent=2))

    entries = (existing or {}).get("lore_entries")
    known_keys = [key for raw in (entries if isinstance(entries, list) else [])
                  if isinstance(raw, dict) for key in words(raw.get("keys"))]
    if known_keys:
        parts.append("EXISTING LOREBOOK KEYWORDS (cover other subjects):\n"
                     + ", ".join(dict.fromkeys(known_keys)))

    parts.append("Reply with the JSON now.")

    return PromptPayload(
        system=CARD_ASSISTANT_PROMPT,
        messages=[{"role": "user", "content": "\n\n".join(parts)}],
        stop=[],
    )
