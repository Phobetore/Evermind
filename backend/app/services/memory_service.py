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
from ..errors import (
    MODEL_UNREADABLE,
    NO_CONNECTION,
    AppError,
    NotFoundError,
    model_failure,
)
from ..prompting import embeddings
from ..prompting.engine import active_content
from ..prompting.memory_changes import is_movable, plan_consolidation, plan_memory_changes
from ..prompting.payloads import (
    MIN_FACTS_TO_CONSOLIDATE,
    build_consolidation_payload,
    build_extraction_payload,
    movable_facts,
)
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
    """One extraction+summary pass. Returns {"facts_added": [...], "summary": str}, with
    "skipped" set to "busy" and nothing looked at when another pass, an extraction or a
    consolidation, was running."""
    if convo_id in _running:
        return {"facts_added": [], "summary": None, "skipped": "busy"}
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
        raise AppError("No LLM connection configured.", 502, kind=NO_CONNECTION)
    return connection


async def consolidate(db: aiosqlite.Connection, convo_id: str) -> dict:
    """Merge non-pinned facts into a shorter, denser set (pinned untouched).
    Returns {"before": n, "after": n, "memories": [...]}, with "skipped" set and nothing
    changed when there were too few facts, or when one of those sent to the model was
    changed, pinned or deleted while it answered ("changed"), or another pass, an
    extraction or a consolidation, was running ("busy")."""
    if convo_id in _running:
        facts = await memories_repo.list_for_conversation(db, convo_id)
        return {"before": len(facts), "after": len(facts), "memories": facts, "skipped": "busy"}
    _running.add(convo_id)
    try:
        return await _consolidate(db, convo_id)
    finally:
        _running.discard(convo_id)


async def _consolidate(db: aiosqlite.Connection, convo_id: str) -> dict:
    convo = await convo_repo.get(db, convo_id, with_messages=False)
    if not convo:
        raise NotFoundError("Conversation not found.", "conversation")
    character = await characters_repo.get_raw(db, convo["character_id"]) or {}
    connection = await _resolve_connection(db, convo)
    persona = await personas_repo.for_conversation(db, convo)

    all_facts = await memories_repo.list_for_conversation(db, convo_id)
    movable = movable_facts(all_facts)
    if len(movable) < MIN_FACTS_TO_CONSOLIDATE:
        return {"before": len(all_facts), "after": len(all_facts),
                "memories": all_facts, "skipped": "too_few"}

    payload = build_consolidation_payload(character, persona, movable)
    chunks: list[str] = []
    async for event in get_provider(connection).stream_chat(payload):
        if event.type == "delta":
            chunks.append(event.text)
        elif event.type == "error":
            raise model_failure(event.message, event.meta)

    merged = plan_consolidation(parse_llm_json("".join(chunks)), movable)
    if merged is None:
        raise AppError("Unreadable consolidation — try again.", 502, kind=MODEL_UNREADABLE)

    # The memory as it is now rather than before the model was asked. The merge was
    # written from all the facts that were sent: if one of them was edited, pinned or
    # deleted since, its old text may be inside a merged fact, and removing only the
    # others would keep both.
    now = await memories_repo.list_for_conversation(db, convo_id)
    still = {(m["id"], m["content"]) for m in movable_facts(now)}
    if any((m["id"], m["content"]) not in still for m in movable):
        return {"before": len(now), "after": len(now), "memories": now, "skipped": "changed"}

    # The merged facts first, then the ones they replace: an error or a stop in between
    # leaves a fact twice, never a fact lost. A fact that the merge repeats stays as it
    # is, since adding it again is refused as a double. And a delete asks again whether
    # the fact is still the one that was sent: a person may pin or edit it just now.
    for f in merged["facts"]:
        await memories_repo.add(db, convo_id, content=f["content"], kind=f["kind"],
                                source_position=merged["source_position"], source="auto")
    kept = {f["content"] for f in merged["facts"]}
    for m in movable:
        if m["content"] not in kept:
            await memories_repo.delete_if_unchanged(db, m["id"], m["content"])
    remaining = await memories_repo.list_for_conversation(db, convo_id)
    return {"before": len(now), "after": len(remaining), "memories": remaining}


async def _apply(db: aiosqlite.Connection, convo_id: str, ops: list[dict]) -> list[dict]:
    """Make the changes of ``plan_memory_changes`` one after the other, and return the
    facts that were added. The plan was made from the facts as they were read, and a
    person can act on them while it is written: a fact that cannot be found any more,
    or that is no longer the model's to move, is left alone, and the write itself asks
    again, since working out a vector can take a while."""
    added = []
    for op in ops:
        if op["op"] == "add":
            saved = await memories_repo.add(
                db, convo_id, content=op["content"], kind=op["kind"],
                source_position=op["source_position"], source=op["source"])
            if saved:
                added.append(saved)
            continue
        target = await memories_repo.find_by_content(db, convo_id, op["target"])
        if target is None or not is_movable(target):
            continue
        if op["op"] == "update":
            await memories_repo.update_if_unchanged(db, target["id"], op["target"], op["content"])
        else:
            await memories_repo.delete_if_unchanged(db, target["id"], op["target"])
    return added


async def _run(db: aiosqlite.Connection, convo_id: str) -> dict:
    convo = await convo_repo.get(db, convo_id, with_messages=False)
    if not convo:
        raise NotFoundError("Conversation not found.", "conversation")
    character = await characters_repo.get_raw(db, convo["character_id"]) or {}
    persona = await personas_repo.for_conversation(db, convo)

    connection = await _resolve_connection(db, convo)

    messages = await convo_repo.list_messages(db, convo_id)
    existing = await memories_repo.list_for_conversation(db, convo_id)
    built = build_extraction_payload(character, persona, convo, messages, existing)
    if built is None:
        return {"facts_added": [], "summary": convo.get("summary") or ""}
    payload, top_position = built

    chunks: list[str] = []
    async for event in get_provider(connection).stream_chat(payload):
        if event.type == "delta":
            chunks.append(event.text)
        elif event.type == "error":
            raise model_failure(event.message, event.meta)

    parsed = parse_llm_json("".join(chunks))
    if parsed is None:
        raise AppError("Unreadable memory response (JSON expected).", 502,
                       kind=MODEL_UNREADABLE)

    # What the memory holds now rather than before the model was asked: a fact
    # pinned in the meantime is no longer one to correct or drop.
    changes = plan_memory_changes(
        parsed, await memories_repo.list_in_lookup_order(db, convo_id), top_position)
    added = await _apply(db, convo_id, changes["ops"])

    updates: dict = {}
    if changes["summary"]:
        updates["summary"] = changes["summary"]
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
