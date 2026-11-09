"""AI-assisted card creation: one brief in, a complete card draft out.

The draft is returned to the editor for the creator to adjust — nothing is
persisted here. Uses the requested connection, else the default one.
"""

import aiosqlite

from ..errors import MODEL_EMPTY, MODEL_UNREADABLE, NO_CONNECTION, AppError
from ..prompting.payloads import (
    LIST_FIELDS,
    TEXT_FIELDS,
    build_card_payload,
    existing_fields,
    words,
)
from ..prompting.text import text_of
from ..providers import complete, get_provider
from ..repositories import connections as connections_repo
from .llm_json import parse_llm_json

_MAX_LORE_ENTRIES = 8


async def _resolve_connection(db: aiosqlite.Connection, connection_id: str | None) -> dict:
    connection = await connections_repo.resolve(db, connection_id)
    if connection is None:
        raise AppError(
            "No LLM connection configured. Add one in Settings → LLM connections.",
            kind=NO_CONNECTION)
    return connection


def clean_card_draft(draft: dict) -> dict:
    """Whitelist and normalize what the model returned."""
    out: dict = {}
    for field in TEXT_FIELDS:
        value = text_of(draft.get(field))
        if value:
            out[field] = value
    for field in LIST_FIELDS:
        items = words(draft.get(field))
        if items:
            out[field] = items
    if "tags" in out:
        out["tags"] = [t.lower()[:40] for t in out["tags"]][:8]

    entries = []
    lore = draft.get("lore_entries")
    for raw in (lore if isinstance(lore, list) else [])[:_MAX_LORE_ENTRIES]:
        if not isinstance(raw, dict):
            continue
        keys = words(raw.get("keys"))
        content = text_of(raw.get("content"))
        if keys and content:
            entries.append({"keys": keys[:6], "content": content})
    if entries:
        out["lore_entries"] = entries
    return out


async def generate_card(db: aiosqlite.Connection, prompt: str, kind: str,
                        connection_id: str | None = None,
                        existing: dict | None = None) -> dict:
    connection = await _resolve_connection(db, connection_id)
    # A card cut short is unreadable JSON, so a ceiling the connection sets is raised.
    if connection.get("max_tokens"):
        connection = dict(connection, max_tokens=max(2048, connection["max_tokens"]))

    payload = build_card_payload(prompt, kind, existing)
    parsed = parse_llm_json(await complete(get_provider(connection), payload))
    if parsed is None:
        raise AppError("The model did not return a readable card. Try again.", 502,
                       kind=MODEL_UNREADABLE)
    draft = clean_card_draft(parsed)
    if not draft:
        raise AppError("The model returned an empty card. Try again.", 502, kind=MODEL_EMPTY)
    # never overwrite what the creator already wrote
    for key, value in existing_fields(existing).items():
        draft[key] = value
    return draft
