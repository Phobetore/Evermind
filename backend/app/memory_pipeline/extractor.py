"""Memory extraction — parses LLM extraction output into structured memory items."""

from __future__ import annotations

import json
import logging
from typing import Any

from app.prompting.templates import MEMORY_EXTRACTION

logger = logging.getLogger(__name__)


def build_extraction_prompt(
    char_name: str,
    recent_messages_text: str,
    world_state_json: str = "{}",
    user_label: str = "User",
) -> list[dict[str, str]]:
    """Build the OpenAI-compatible messages for the memory extraction call.

    Returns a ``[{"role": "system", "content": …}]`` list suitable for
    a non-streaming ``/v1/chat/completions`` call to the memory LLM.
    """
    prompt = MEMORY_EXTRACTION.format(
        char_name=char_name,
        user_label=user_label,
        world_state_json=world_state_json,
        recent_messages_for_extract=recent_messages_text,
    )
    return [{"role": "system", "content": prompt}]


def parse_extraction_response(raw_text: str) -> dict[str, Any]:
    """Parse the JSON output from the memory extraction LLM.

    Returns the parsed dict with keys ``semantic``, ``episodic``,
    ``world_updates``, ``contradictions``.  Falls back to empty lists
    on any parse error.
    """
    empty: dict[str, Any] = {
        "semantic": [],
        "episodic": [],
        "world_updates": [],
        "contradictions": [],
    }

    # Strip markdown fences if the model wraps the JSON
    text = raw_text.strip()
    if text.startswith("```"):
        # Remove opening fence (```json or ```)
        first_newline = text.find("\n")
        if first_newline == -1:
            # No newline after opening fence — nothing useful to parse
            logger.warning("Malformed markdown fence in extraction: %s", raw_text[:200])
            return empty
        text = text[first_newline + 1 :]
        # Remove closing fence
        if text.rstrip().endswith("```"):
            text = text.rstrip()[: -len("```")]

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("Failed to parse memory extraction JSON: %s", raw_text[:200])
        return empty

    if not isinstance(data, dict):
        logger.warning("Memory extraction returned non-dict: %s", type(data))
        return empty

    # Validate and normalise each key
    for key in ("semantic", "episodic", "world_updates", "contradictions"):
        val = data.get(key)
        if not isinstance(val, list):
            data[key] = []

    return {k: data.get(k, []) for k in empty}
