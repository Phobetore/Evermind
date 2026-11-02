"""The prompts that are not a chat turn's: ghost-writing the player's next message,
summarizing, extracting and consolidating the memory, and drafting a card.

Pure, with no database and no model, so that frontend/src/engine/payloads.ts can
answer the same cases (parity/payloads.json). The services fetch what these read,
send what they return, and say what went wrong.
"""

import json

from .defaults import (
    CARD_ASSISTANT_PROMPT,
    IMPERSONATE_PROMPT,
    MEMORY_CONSOLIDATION_PROMPT,
    MEMORY_EXTRACTION_PROMPT,
    SUMMARIZE_PROMPT,
)
from .engine import PromptPayload, active_content, build_chat_payload
from .macros import substitute
from .memory_changes import is_movable

MAX_TURNS_PER_RUN = 40  # safety cap on turns fed to one extraction call
MIN_FACTS_TO_CONSOLIDATE = 8  # fewer than this and merging them is not worth a call

TEXT_FIELDS = ("name", "tagline", "description", "personality", "scenario",
               "greeting", "example_dialogues")
LIST_FIELDS = ("alternate_greetings", "tags")


def build_impersonate_payload(character: dict, persona: dict | None, conversation: dict,
                              messages: list[dict], connection: dict,
                              memories: list[dict] | None = None) -> PromptPayload:
    """The prompt that ghost-writes the player's next message."""
    char_name = character.get("name") or "Character"
    user_name = (persona or {}).get("name") or "User"
    base = build_chat_payload(character=character, persona=persona, conversation=conversation,
                              messages=messages, connection=connection, memories=memories)

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


def build_summary_payload(character: dict, persona: dict | None, conversation: dict,
                          messages: list[dict], connection: dict) -> PromptPayload:
    """The prompt that writes the story so far."""
    char_name = character.get("name") or "Character"
    user_name = (persona or {}).get("name") or "User"
    base = build_chat_payload(character=character, persona=persona, conversation=conversation,
                              messages=messages, connection=connection)
    return PromptPayload(
        system=substitute(SUMMARIZE_PROMPT, char_name=char_name, user_name=user_name),
        messages=[*base.messages,
                  {"role": "user", "content": "[Write the summary of the roleplay so far now.]"}],
        stop=[],
    )


def build_extraction_payload(character: dict, persona: dict | None, conversation: dict,
                             messages: list[dict],
                             memories: list[dict]) -> tuple[PromptPayload, int] | None:
    """The prompt that reads the turns since the last pass for new facts and a new
    summary, and the position of the newest of those turns. None when there is no
    turn since."""
    char_name = character.get("name") or "Character"
    user_name = (persona or {}).get("name") or "User"
    memory_position = conversation.get("memory_position") or 0

    new_turns = [m for m in messages if m["position"] > memory_position][-MAX_TURNS_PER_RUN:]
    if not new_turns:
        return None
    top_position = max(m["position"] for m in new_turns)

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
    return payload, top_position


def movable_facts(memories: list[dict]) -> list[dict]:
    """The facts that consolidation may merge: neither pinned nor written by hand."""
    return [m for m in memories if is_movable(m)]


def build_consolidation_payload(character: dict, persona: dict | None,
                                movable: list[dict]) -> PromptPayload:
    """The prompt that merges these facts into a shorter, denser set."""
    char_name = character.get("name") or "Character"
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


def lore_keyword(key: object) -> str:
    """The text of a keyword of an existing lorebook entry, "" when it is none. A
    string, or a whole number written out. Anything else is not a keyword:
    ``str()`` of it would hand the model "None" or "True" as a subject to avoid."""
    if isinstance(key, str):
        return key.strip()
    if isinstance(key, int) and not isinstance(key, bool):
        return str(key)
    return ""


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

    # A lorebook, or the keys of an entry, that is not a list holds nothing,
    # whatever it is: a string is not a list of letters.
    known_keys = []
    entries = (existing or {}).get("lore_entries")
    for raw in entries if isinstance(entries, list) else []:
        if isinstance(raw, dict):
            keys = raw.get("keys")
            known_keys += [text for text in map(lore_keyword, keys if isinstance(keys, list) else [])
                           if text]
    if known_keys:
        parts.append("EXISTING LOREBOOK KEYWORDS (cover other subjects):\n"
                     + ", ".join(dict.fromkeys(known_keys)))

    parts.append("Reply with the JSON now.")

    return PromptPayload(
        system=CARD_ASSISTANT_PROMPT,
        messages=[{"role": "user", "content": "\n\n".join(parts)}],
        stop=[],
    )
