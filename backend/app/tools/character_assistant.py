"""Character assistant — LLM-powered character generation tool.

Given a set of creative inputs (name, theme, style, etc.) this module
builds a prompt for the chat LLM and parses the structured JSON
response into a ``CharacterCreate``-compatible dict.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.core.llm_client import LLMClient

logger = logging.getLogger(__name__)

CHARACTER_ASSISTANT_PROMPT = """CHARACTER CREATION ASSISTANT

You are a creative writing assistant.  Your task is to generate a complete
roleplay character profile given the inputs below.

INPUTS:
- Name: {name}
- Theme / Genre: {theme}
- Relationship to user: {relationship}
- Writing style: {style}
- Limits / Boundaries: {limits}
- Additional notes: {notes}

Generate a complete character profile as **valid JSON only** (no markdown
fences, no extra text).  The JSON must contain exactly these keys:

{{
  "name": "{name}",
  "tags": ["tag1", "tag2", "tag3"],
  "summary": "2–3 sentence overview of the character",
  "persona": "Detailed personality description (3–5 sentences)",
  "writing_style": "How the character writes (tone, vocabulary, quirks)",
  "scenario": "Starting situation / context (2–3 sentences)",
  "first_message": "The character's opening message to the user",
  "example_dialogues": [
    {{"user": "example user message", "assistant": "example character reply"}},
    {{"user": "another user message", "assistant": "another reply"}}
  ],
  "boundaries": "What the character will NOT do",
  "system_rules": "Any special rules the character follows",
  "memory_seed": [
    {{"type": "semantic", "title": "short", "content": "one sentence fact"}}
  ]
}}

GUIDELINES:
- Produce 2–4 example dialogues showing the character's voice.
- Produce 3–5 memory_seed items (mix of semantic and episodic).
- Keep the persona immersive — no meta or AI references.
- The writing_style should be distinctive and consistent.
- Boundaries should respect the limits provided by the user.
- JSON must be valid and parseable.

OUTPUT JSON ONLY:"""


def build_assistant_prompt(
    name: str,
    theme: str = "",
    relationship: str = "",
    style: str = "",
    limits: str = "",
    notes: str = "",
) -> list[dict[str, str]]:
    """Build the OpenAI-compatible messages list for the character assistant."""
    content = CHARACTER_ASSISTANT_PROMPT.format(
        name=name,
        theme=theme or "(any)",
        relationship=relationship or "(unspecified)",
        style=style or "(natural)",
        limits=limits or "(standard safe defaults)",
        notes=notes or "(none)",
    )
    return [{"role": "system", "content": content}]


def parse_assistant_response(raw_text: str) -> dict[str, Any]:
    """Parse the JSON response from the character assistant LLM.

    Returns a dict suitable for ``CharacterCreate``.
    Falls back to partial data on parse failure.
    """
    text = raw_text.strip()

    # Strip markdown fences
    if text.startswith("```"):
        first_nl = text.find("\n")
        if first_nl != -1:
            text = text[first_nl + 1 :]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("Failed to parse character assistant JSON: %s", raw_text[:300])
        return {"name": "", "tags": [], "summary": "", "persona": ""}

    if not isinstance(data, dict):
        logger.warning("Character assistant returned non-dict: %s", type(data))
        return {"name": "", "tags": [], "summary": "", "persona": ""}

    # Normalise expected fields
    defaults: dict[str, Any] = {
        "name": "",
        "tags": [],
        "summary": "",
        "persona": "",
        "writing_style": "",
        "scenario": "",
        "first_message": "",
        "example_dialogues": [],
        "boundaries": "",
        "system_rules": "",
        "memory_seed": [],
    }
    for key, default in defaults.items():
        if key not in data or not isinstance(data[key], type(default)):
            data[key] = default

    return {k: data.get(k, v) for k, v in defaults.items()}


async def generate_character(
    llm: LLMClient,
    name: str,
    theme: str = "",
    relationship: str = "",
    style: str = "",
    limits: str = "",
    notes: str = "",
) -> dict[str, Any]:
    """Call the LLM to generate a complete character profile.

    Returns a dict compatible with ``CharacterCreate``.
    """
    messages = build_assistant_prompt(
        name=name,
        theme=theme,
        relationship=relationship,
        style=style,
        limits=limits,
        notes=notes,
    )

    # Use streaming so that httpx's read timeout applies per-chunk rather
    # than to the entire response.  Local LLMs generating large JSON
    # profiles can easily exceed a flat read timeout even though tokens
    # are being produced continuously.
    chunks: list[str] = []
    async for chunk in llm.chat_completion_stream(
        messages, temperature=0.8, max_tokens=2048
    ):
        delta = chunk.get("choices", [{}])[0].get("delta", {})
        token = delta.get("content", "")
        if token:
            chunks.append(token)
    raw = "".join(chunks)

    result = parse_assistant_response(raw)
    # Ensure name is set from input
    if not result.get("name"):
        result["name"] = name

    return result
