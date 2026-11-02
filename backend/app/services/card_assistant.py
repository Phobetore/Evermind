"""AI-assisted card creation: one brief in, a complete card draft out.

The draft is returned to the editor for the creator to adjust — nothing is
persisted here. Uses the requested connection, else the default one.
"""

import aiosqlite

from ..errors import (
    MODEL_EMPTY,
    MODEL_UNREADABLE,
    NO_CONNECTION,
    AppError,
    model_failure,
)
from ..prompting.payloads import LIST_FIELDS, TEXT_FIELDS, build_card_payload, existing_fields
from ..providers import get_provider
from ..repositories import connections as connections_repo
from ..repositories import settings as settings_repo
from .llm_json import parse_llm_json

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
            "No LLM connection configured. Add one in Settings → LLM connections.",
            kind=NO_CONNECTION)
    return connection


def _clean(draft: dict) -> dict:
    """Whitelist and normalize what the model returned."""
    out: dict = {}
    for field in TEXT_FIELDS:
        value = draft.get(field)
        if isinstance(value, str) and value.strip():
            out[field] = value.strip()
    for field in LIST_FIELDS:
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

    payload = build_card_payload(prompt, kind, existing)

    chunks: list[str] = []
    async for event in get_provider(connection).stream_chat(payload):
        if event.type == "delta":
            chunks.append(event.text)
        elif event.type == "error":
            raise model_failure(event.message, event.meta)

    parsed = parse_llm_json("".join(chunks))
    if parsed is None:
        raise AppError("The model did not return a readable card. Try again.", 502,
                       kind=MODEL_UNREADABLE)
    draft = _clean(parsed)
    if not draft:
        raise AppError("The model returned an empty card. Try again.", 502, kind=MODEL_EMPTY)
    # never overwrite what the creator already wrote
    for key, value in existing_fields(existing).items():
        draft[key] = value
    return draft
