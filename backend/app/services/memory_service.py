"""Self-maintained long-term memory.

Every MAINTENANCE_EVERY assistant replies, one LLM call (the conversation's
own connection) extracts new durable facts and rewrites the running summary
to cover everything up to the latest turn. Runs as a background task with its
own SQLite connection; a per-conversation guard prevents overlapping runs.
"""

import asyncio
import logging

import aiosqlite

from ..db import _connect
from ..prompting import embeddings
from ..prompting.defaults import MEMORY_CONSOLIDATION_PROMPT, MEMORY_EXTRACTION_PROMPT
from ..prompting.engine import PromptPayload, active_content
from ..prompting.macros import substitute
from ..providers import get_provider
from ..repositories import characters as characters_repo
from ..repositories import connections as connections_repo
from ..repositories import conversations as convo_repo
from ..repositories import memories as memories_repo
from ..repositories import personas as personas_repo
from ..repositories import settings as settings_repo
from .llm_json import parse_llm_json

logger = logging.getLogger(__name__)

MAINTENANCE_EVERY = 6  # assistant replies between maintenance runs
_MAX_TURNS_PER_RUN = 40  # safety cap on turns fed to one extraction call

_running: set[str] = set()


async def _new_assistant_count(db: aiosqlite.Connection, convo: dict) -> int:
    row = await (await db.execute(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?"
        " AND role = 'assistant' AND position > ?",
        (convo["id"], convo.get("memory_position") or 0))).fetchone()
    return row["n"]


async def is_due(db: aiosqlite.Connection, convo_id: str) -> bool:
    settings = await settings_repo.get_all(db)
    if settings.get("auto_memory") is False:
        return False
    convo = await convo_repo.get(db, convo_id, with_messages=False)
    if not convo:
        return False
    return await _new_assistant_count(db, convo) >= MAINTENANCE_EVERY


def schedule_if_due(convo_id: str) -> None:
    """Fire-and-forget: check + run with a dedicated DB connection."""
    if convo_id in _running:
        return

    async def _task():
        db = await _connect()
        try:
            if await is_due(db, convo_id):
                await run_maintenance(db, convo_id)
        except Exception:
            logger.exception("memory maintenance failed for %s", convo_id)
        finally:
            await db.close()

    asyncio.get_running_loop().create_task(_task())


async def run_maintenance(db: aiosqlite.Connection, convo_id: str) -> dict:
    """One extraction+summary pass. Returns {"facts_added": [...], "summary": str}."""
    if convo_id in _running:
        return {"facts_added": [], "summary": None, "skipped": "already_running"}
    _running.add(convo_id)
    try:
        return await _run(db, convo_id)
    finally:
        _running.discard(convo_id)


async def _resolve_connection(db: aiosqlite.Connection, convo: dict) -> dict:
    connection = None
    if convo.get("connection_id"):
        connection = await connections_repo.get_raw(db, convo["connection_id"])
    if connection is None:
        settings = await settings_repo.get_all(db)
        if settings.get("default_connection_id"):
            connection = await connections_repo.get_raw(db, settings["default_connection_id"])
    if connection is None:
        connection = await connections_repo.get_default_raw(db)
    if connection is None:
        raise ValueError("No LLM connection configured.")
    return connection


async def consolidate(db: aiosqlite.Connection, convo_id: str) -> dict:
    """Merge non-pinned facts into a shorter, denser set (pinned untouched).
    Returns {"before": n, "after": n, "memories": [...]}."""
    convo = await convo_repo.get(db, convo_id, with_messages=False)
    if not convo:
        raise ValueError("Conversation not found.")
    character = await characters_repo.get_raw(db, convo["character_id"]) or {}
    connection = await _resolve_connection(db, convo)
    char_name = character.get("name") or "Character"
    persona = await personas_repo.get(db, convo["persona_id"]) if convo.get("persona_id") else None
    user_name = (persona or {}).get("name") or "User"

    all_facts = await memories_repo.list_for_conversation(db, convo_id)
    movable = [m for m in all_facts if not m["is_pinned"] and m["source"] == "auto"]
    if len(movable) < 8:
        return {"before": len(all_facts), "after": len(all_facts),
                "memories": all_facts, "skipped": "too_few"}

    facts_block = "\n".join(f"- {m['content']}" for m in movable)
    payload = PromptPayload(
        system=substitute(MEMORY_CONSOLIDATION_PROMPT, char_name=char_name, user_name=user_name),
        messages=[{"role": "user", "content": f"FACTS TO CONSOLIDATE:\n{facts_block}\n\nReply with the JSON now."}],
        stop=[],
    )
    chunks: list[str] = []
    async for event in get_provider(connection).stream_chat(payload):
        if event.type == "delta":
            chunks.append(event.text)
        elif event.type == "error":
            raise ValueError(event.message)
    parsed = parse_llm_json("".join(chunks))
    merged = [f for f in (parsed or {}).get("facts") or []
              if isinstance(f, dict) and str(f.get("content") or "").strip()]
    if not merged:
        raise ValueError("Unreadable consolidation — try again.")

    # Merged facts inherit the OLDEST source position: consolidation produces
    # long-term memory, and a recent stamp would make the engine treat it as
    # covered by the visible history window and mute it for dozens of turns.
    base_position = min((m["source_position"] for m in movable), default=0)
    for m in movable:
        await memories_repo.delete(db, m["id"])
    for f in merged[:30]:
        await memories_repo.add(db, convo_id, content=str(f.get("content")),
                                kind=str(f.get("kind") or "fact"),
                                source_position=base_position, source="auto")
    remaining = await memories_repo.list_for_conversation(db, convo_id)
    return {"before": len(all_facts), "after": len(remaining), "memories": remaining}


async def _run(db: aiosqlite.Connection, convo_id: str) -> dict:
    convo = await convo_repo.get(db, convo_id, with_messages=False)
    if not convo:
        raise ValueError("Conversation not found.")
    character = await characters_repo.get_raw(db, convo["character_id"]) or {}
    persona = await personas_repo.get(db, convo["persona_id"]) if convo.get("persona_id") else None
    if persona is None:
        persona = await personas_repo.get_default(db)

    connection = await _resolve_connection(db, convo)

    char_name = character.get("name") or "Character"
    user_name = (persona or {}).get("name") or "User"
    memory_position = convo.get("memory_position") or 0

    messages = await convo_repo.list_messages(db, convo_id)
    new_turns = [m for m in messages if m["position"] > memory_position][-_MAX_TURNS_PER_RUN:]
    if not new_turns:
        return {"facts_added": [], "summary": convo.get("summary") or ""}
    top_position = max(m["position"] for m in new_turns)

    existing = await memories_repo.list_for_conversation(db, convo_id)
    facts_block = "\n".join(f"- {m['content']}" for m in existing) or "(none yet)"
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
                f"CURRENT SUMMARY:\n{convo.get('summary') or '(empty)'}\n\n"
                f"FACTS ALREADY RECORDED:\n{facts_block}\n\n"
                f"NEWEST TURNS:\n{turns_block}\n\n"
                "Reply with the JSON now."
            ),
        }],
        stop=[],
    )

    chunks: list[str] = []
    async for event in get_provider(connection).stream_chat(payload):
        if event.type == "delta":
            chunks.append(event.text)
        elif event.type == "error":
            raise ValueError(event.message)

    parsed = parse_llm_json("".join(chunks))
    if parsed is None:
        raise ValueError("Unreadable memory response (JSON expected).")

    added = []
    for fact in parsed.get("facts") or []:
        if not isinstance(fact, dict):
            continue
        saved = await memories_repo.add(
            db, convo_id,
            content=str(fact.get("content") or ""),
            kind=str(fact.get("kind") or "fact"),
            source_position=top_position,
            source="auto",
        )
        if saved:
            added.append(saved)

    # Maintenance: corrections and merges. Pinned facts are untouchable.
    for update in parsed.get("updated_facts") or []:
        if not isinstance(update, dict):
            continue
        new_content = str(update.get("content") or "").strip()
        if not new_content:
            continue
        target = await memories_repo.find_by_content(db, convo_id,
                                                     str(update.get("replaces") or ""))
        if target is None:
            saved = await memories_repo.add(db, convo_id, content=new_content,
                                            source_position=top_position, source="auto")
            if saved:
                added.append(saved)
        elif not target["is_pinned"]:
            await memories_repo.update(db, target["id"], content=new_content)
    for obsolete in parsed.get("obsolete_facts") or []:
        target = await memories_repo.find_by_content(db, convo_id, str(obsolete or ""))
        if target and not target["is_pinned"] and target["source"] == "auto":
            await memories_repo.delete(db, target["id"])

    updates: dict = {}
    summary = parsed.get("summary")
    if isinstance(summary, str) and summary.strip():
        updates["summary"] = summary.strip()
    await convo_repo.update(db, convo_id, updates)
    await db.execute("UPDATE conversations SET memory_position = ? WHERE id = ?",
                     (top_position, convo_id))
    await db.commit()

    return {"facts_added": added, "summary": updates.get("summary", convo.get("summary") or "")}


async def backfill_embeddings(db: aiosqlite.Connection) -> int:
    """Encode facts still missing a vector. Best-effort: returns how many were
    filled (0 if the model is unavailable). Never raises."""
    missing = await memories_repo.list_missing_embeddings(db)
    filled = 0
    for fact in missing:
        vectors = await embeddings.embed([fact["content"]], kind="passage")
        if vectors:
            await memories_repo.set_embedding(db, fact["id"], embeddings.pack(vectors[0]))
            filled += 1
    if filled:
        logger.info("semantic memory: backfilled %d fact embeddings", filled)
    return filled


async def backfill_message_embeddings(db: aiosqlite.Connection) -> int:
    """Encode messages still missing a vector (their ACTIVE variant). Best-effort:
    returns how many were filled (0 if the model is unavailable). Never raises."""
    missing = await convo_repo.list_messages_missing_embeddings(db)
    filled = 0
    for msg in missing:
        vectors = await embeddings.embed([active_content(msg)], kind="passage")
        if vectors:
            await convo_repo.set_message_embedding(db, msg["id"], embeddings.pack(vectors[0]))
            filled += 1
    if filled:
        logger.info("semantic memory: backfilled %d message embeddings", filled)
    return filled


async def warmup_and_backfill() -> None:
    """Startup task: load the model (the only place a download can happen),
    then backfill existing facts and messages. Own DB connection. Never blocks."""
    if not await embeddings.warmup():
        return
    db = await _connect()
    try:
        await backfill_embeddings(db)
        await backfill_message_embeddings(db)
    except Exception:
        logger.exception("semantic memory backfill failed")
    finally:
        await db.close()
