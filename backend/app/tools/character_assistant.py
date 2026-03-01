"""Character assistant — LLM-powered character generation tool.

Given a set of creative inputs (name, theme, style, etc.) this module
builds a prompt for the chat LLM and parses the structured JSON
response into a ``CharacterCreate``-compatible dict.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

    from app.core.llm_client import LLMClient

logger = logging.getLogger(__name__)

# Maximum seconds of *inactivity* (no new token) before we consider the
# generation stalled.  This is deliberately independent of total wall-clock
# time: as long as the LLM keeps producing tokens the generation is allowed
# to continue.
_INACTIVITY_TIMEOUT: float = 90.0

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
- Produce 3–5 example dialogues showing the character's voice.
- Produce 3–8 memory_seed items (mix of semantic and episodic).
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
    return [
        {"role": "system", "content": content},
        {"role": "user", "content": "Generate the character profile now."},
    ]


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
    *,
    inactivity_timeout: float | None = None,
) -> dict[str, Any]:
    """Call the LLM to generate a complete character profile.

    Uses **streaming** so that only *inactivity* (no new data for
    *inactivity_timeout* seconds) causes a timeout.  Total wall-clock
    time is unlimited as long as the LLM keeps producing tokens, which
    avoids spurious 504s on slow-but-active servers.

    Returns a dict compatible with ``CharacterCreate``.
    """
    if inactivity_timeout is None:
        inactivity_timeout = _INACTIVITY_TIMEOUT
    messages = build_assistant_prompt(
        name=name,
        theme=theme,
        relationship=relationship,
        style=style,
        limits=limits,
        notes=notes,
    )

    tokens: list[str] = []
    stream = llm.chat_completion_stream(
        messages, temperature=0.8, max_tokens=2048
    )
    ait = stream.__aiter__()
    try:
        deadline = asyncio.get_event_loop().time() + inactivity_timeout
        async with asyncio.timeout_at(deadline) as cm:
            while True:
                try:
                    chunk = await ait.__anext__()
                except StopAsyncIteration:
                    break
                choices = chunk.get("choices", [])
                if not choices:
                    continue
                delta = choices[0].get("delta", {})
                token = delta.get("content", "")
                if token:
                    tokens.append(token)
                    # Reset the inactivity deadline on every received token
                    cm.reschedule(asyncio.get_event_loop().time() + inactivity_timeout)
    except TimeoutError:
        logger.warning(
            "Character generation stalled — no data received for %ss",
            inactivity_timeout,
        )
        raise
    finally:
        # Ensure the async generator is closed even on timeout/error so that
        # the underlying httpx stream context managers are cleaned up.
        with contextlib.suppress(Exception):
            await ait.aclose()

    raw = "".join(tokens)

    result = parse_assistant_response(raw)
    # Ensure name is set from input
    if not result.get("name"):
        result["name"] = name

    return result


async def generate_character_stream(
    llm: LLMClient,
    name: str,
    theme: str = "",
    relationship: str = "",
    style: str = "",
    limits: str = "",
    notes: str = "",
) -> AsyncGenerator[str, None]:
    """Yield raw tokens from the LLM as they arrive.

    Unlike :func:`generate_character` this function streams individual
    tokens to the caller so that an SSE endpoint can forward them
    immediately — keeping the HTTP connection alive and eliminating
    idle-connection timeouts.
    """
    messages = build_assistant_prompt(
        name=name,
        theme=theme,
        relationship=relationship,
        style=style,
        limits=limits,
        notes=notes,
    )

    stream = llm.chat_completion_stream(
        messages, temperature=0.8, max_tokens=2048
    )
    async for chunk in stream:
        choices = chunk.get("choices", [])
        if not choices:
            continue
        delta = choices[0].get("delta", {})
        token = delta.get("content", "")
        if token:
            yield token
