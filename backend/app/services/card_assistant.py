"""AI-assisted card creation: one brief in, a complete card draft out.

The draft is returned to the editor for the creator to adjust — nothing is
persisted here. Uses the requested connection, else the default one.
"""

import json

import aiosqlite

from ..errors import AppError
from ..prompting.defaults import CARD_ASSISTANT_PROMPT
from ..prompting.engine import PromptPayload
from ..providers import get_provider
from ..repositories import connections as connections_repo
from ..repositories import settings as settings_repo
from .llm_json import parse_llm_json

_TEXT_FIELDS = ("name", "tagline", "description", "personality", "scenario",
                "greeting", "example_dialogues")
_LIST_FIELDS = ("alternate_greetings", "tags")
_MAX_LORE_ENTRIES = 8


async def _resolve_connection(db: aiosqlite.Connection, connection_id: str | None) -> dict:
    connection = None
    if connection_id:
        connection = await connections_repo.get_raw(db, connection_id)
    if connection is None:
        settings = await settings_repo.get_all(db)
        if settings.get("default_connection_id"):
            connection = await connections_repo.get_raw(db, settings["default_connection_id"])
    if connection is None:
        connection = await connections_repo.get_default_raw(db)
    if connection is None:
        raise AppError(
            "No LLM connection configured. Add one in Settings → LLM connections.")
    return connection


def _clean(draft: dict) -> dict:
    """Whitelist and normalize what the model returned."""
    out: dict = {}
    for field in _TEXT_FIELDS:
        value = draft.get(field)
        if isinstance(value, str) and value.strip():
            out[field] = value.strip()
    for field in _LIST_FIELDS:
        value = draft.get(field)
        if isinstance(value, list):
            items = [str(v).strip() for v in value if str(v).strip()]
            if items:
                out[field] = items
        elif isinstance(value, str) and value.strip():
            out[field] = [value.strip()]
    if "tags" in out:
        out["tags"] = [t.lower()[:40] for t in out["tags"]][:8]

    entries = []
    for raw in (draft.get("lore_entries") or [])[:_MAX_LORE_ENTRIES]:
        if not isinstance(raw, dict):
            continue
        keys = [str(k).strip() for k in raw.get("keys") or [] if str(k).strip()]
        content = str(raw.get("content") or "").strip()
        if keys and content:
            entries.append({"keys": keys[:6], "content": content})
    if entries:
        out["lore_entries"] = entries
    return out


async def generate_card(db: aiosqlite.Connection, prompt: str, kind: str,
                        connection_id: str | None = None,
                        existing: dict | None = None) -> dict:
    connection = await _resolve_connection(db, connection_id)
    # A rich card easily exceeds typical chat reply budgets; a truncated JSON
    # is unparseable, so give this call its own generous ceiling.
    connection = dict(connection,
                      max_tokens=max(2048, int(connection.get("max_tokens") or 1024)))

    kind_line = (
        "The card is a SCENARIO (the AI narrates the world and plays every character except the player)."
        if kind == "scenario"
        else "The card is a CHARACTER (the AI embodies one person the player talks to)."
    )
    existing_filled = {k: v for k, v in (existing or {}).items()
                      if isinstance(v, (str, list)) and v and k in _TEXT_FIELDS + _LIST_FIELDS}
    parts = [f"{kind_line}\n\nCREATOR'S BRIEF:\n{prompt.strip()}"]
    if existing_filled:
        parts.append("EXISTING FIELDS (keep their content, fill the rest):\n"
                     + json.dumps(existing_filled, ensure_ascii=False, indent=2))

    known_keys = []
    for raw in (existing or {}).get("lore_entries") or []:
        if isinstance(raw, dict):
            known_keys += [str(k).strip() for k in raw.get("keys") or [] if str(k).strip()]
    if known_keys:
        parts.append("EXISTING LOREBOOK KEYWORDS (cover other subjects):\n"
                     + ", ".join(dict.fromkeys(known_keys)))

    parts.append("Reply with the JSON now.")

    payload = PromptPayload(
        system=CARD_ASSISTANT_PROMPT,
        messages=[{"role": "user", "content": "\n\n".join(parts)}],
        stop=[],
    )

    chunks: list[str] = []
    async for event in get_provider(connection).stream_chat(payload):
        if event.type == "delta":
            chunks.append(event.text)
        elif event.type == "error":
            raise AppError(event.message, 502)

    parsed = parse_llm_json("".join(chunks))
    if parsed is None:
        raise AppError("The model did not return a readable card. Try again.", 502)
    draft = _clean(parsed)
    if not draft:
        raise AppError("The model returned an empty card. Try again.", 502)
    # never overwrite what the creator already wrote
    for key, value in existing_filled.items():
        draft[key] = value
    return draft
