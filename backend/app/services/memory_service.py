"""Self-maintained long-term memory.

A pass is due once MAINTENANCE_EVERY assistant replies are unread: one LLM call (the
conversation's own connection) extracts new durable facts and rewrites the running summary to
cover what it read. An automatic pass leaves the newest HOLD_BACK messages unread, and the
replies among them count toward the next one: with the player and the character taking turns,
the first pass comes after MAINTENANCE_EVERY replies and each later one HOLD_BACK / 2 replies
earlier, after 8 and then every 6. Runs as a background task with its own SQLite connection; a
per-conversation guard prevents overlapping runs.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Iterable

import aiosqlite

from ..db import _connect, write_transaction
from ..errors import (
    CONVERSATION_CHANGED,
    FACTS_CHANGED,
    MEMORY_BUSY,
    MODEL_UNREADABLE,
    NO_CONNECTION,
    TOO_FEW_FACTS,
    AppError,
    NotFoundError,
    error_body,
    model_failure,
)
from ..prompting import embeddings
from ..prompting.engine import active_content
from ..prompting.memory_changes import answer_texts, plan_consolidation, plan_memory_changes
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

MAINTENANCE_EVERY = 8  # unread assistant replies that make a pass due
HOLD_BACK = 4  # newest messages an automatic pass leaves unread: a reply may still be thrown away

MIN_ANSWER_TOKENS = 2048  # a pass's JSON is cut, and unreadable, in less than this

_running: set[str] = set()
# Conversations whose last automatic pass failed: the error body, and how many replies to wait.
_failed: dict[str, dict] = {}


def failure_of(convo_id: str) -> dict | None:
    """Why the last automatic pass failed, shaped as an error response, until one succeeds."""
    failed = _failed.get(convo_id)
    return failed["error"] if failed else None


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
    failed = _failed.get(convo_id)
    if failed:
        failed["left"] -= 1
        if failed["left"] > 0:
            return

    async def _task():
        db = await _connect()
        try:
            if await is_due(db, convo_id):
                await run_maintenance(db, convo_id)
        except AppError as exc:
            if exc.kind in (MEMORY_BUSY, CONVERSATION_CHANGED):
                return  # the next reply asks again
            logger.warning("memory maintenance failed for %s: %s", convo_id, exc.message)
            _failed[convo_id] = {"left": MAINTENANCE_EVERY - 1, "error": error_body(exc)}
        except Exception:
            logger.exception("memory maintenance failed for %s", convo_id)
            _failed[convo_id] = {"left": MAINTENANCE_EVERY - 1,
                                 "error": {"error": "The memory pass failed.", "kind": "internal"}}
        finally:
            await db.close()

    asyncio.get_running_loop().create_task(_task())


async def one_at_a_time(convo_id: str, work: Callable[[], Awaitable[dict]]) -> dict:
    """Run ``work``, unless another memory task is running for this conversation. A pass and a
    consolidation each read the memory, wait for a model, and write what it said, so that the
    two would cross."""
    if convo_id in _running:
        raise AppError("Another memory task is running.", 409, kind=MEMORY_BUSY)
    _running.add(convo_id)
    try:
        return await work()
    finally:
        _running.discard(convo_id)


async def run_maintenance(db: aiosqlite.Connection, convo_id: str,
                          hold_back: int = HOLD_BACK) -> dict:
    """One extraction+summary pass, which leaves the ``hold_back`` newest messages for the
    next. Returns {"facts_added": [...], "summary": str}."""
    async def work() -> dict:
        result = await _run(db, convo_id, hold_back)
        _failed.pop(convo_id, None)
        return result

    return await one_at_a_time(convo_id, work)


async def _resolve_connection(db: aiosqlite.Connection, convo: dict) -> dict:
    connection = await connections_repo.resolve(db, convo.get("connection_id"))
    if connection is None:
        raise AppError("No LLM connection configured.", kind=NO_CONNECTION)
    if connection.get("max_tokens"):
        connection = {**connection, "max_tokens": max(connection["max_tokens"], MIN_ANSWER_TOKENS)}
    return connection


async def consolidate(db: aiosqlite.Connection, convo_id: str) -> dict:
    """Merge non-pinned facts into a shorter, denser set (pinned untouched).
    Returns {"before": n, "after": n, "memories": [...]}."""
    return await one_at_a_time(convo_id, lambda: _consolidate(db, convo_id))


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
        raise AppError("Too few facts to consolidate.", 409, kind=TOO_FEW_FACTS)

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

    vectors = await _vectors_of(merged["facts"])

    # The memory as it is now rather than before the model was asked. The merge was
    # written from all the facts that were sent: if one of them was edited, pinned or
    # deleted since, by a person or by a cut in the story, its old text may be inside a
    # merged fact, and removing only the others would keep both. A merged fact takes the
    # oldest position of those it replaces, so with them all still where they were it is not
    # past the end of the story. One pinned, kept past a cut and unpinned again says the same
    # at another position.
    async with write_transaction(db):
        now = await memories_repo.list_for_conversation(db, convo_id)
        still = {(m["id"], m["content"], m["source_position"]) for m in movable_facts(now)}
        if any((m["id"], m["content"], m["source_position"]) not in still for m in movable):
            raise AppError("The facts changed while the model merged them.", 409,
                           kind=FACTS_CHANGED)

        # A fact that the merge repeats stays as it is, since adding it again is refused
        # as a double.
        for content in merged["facts"]:
            await memories_repo.add_with_vector(db, convo_id, content, merged["source_position"],
                                                vectors.get(content))
        kept = set(merged["facts"])
        for m in movable:
            if m["content"] not in kept:
                await memories_repo.remove(db, m["id"])
        remaining = await memories_repo.list_for_conversation(db, convo_id)
    return {"before": len(now), "after": len(remaining), "memories": remaining}


async def _vectors_of(texts: Iterable[str]) -> dict[str, bytes]:
    """The vectors of these texts, for those that have one: nothing without the semantic
    model, and the next start gives them one. Working them out takes a while, so it
    comes before the database is held."""
    unique = list(dict.fromkeys(texts))
    vectors = await embeddings.embed(unique, kind="passage")
    return {text: embeddings.pack(vector) for text, vector in zip(unique, vectors or [], strict=False)}


async def _apply(db: aiosqlite.Connection, convo_id: str, changes: dict,
                 vectors: dict[str, bytes], top_position: int) -> list[dict]:
    """Make the changes of ``plan_memory_changes``, and return the facts that were added.
    The caller commits."""
    for fact_id in changes["delete"]:
        await memories_repo.remove(db, fact_id)
    for fact_id, content in changes["update"].items():
        await memories_repo.rewrite(db, fact_id, content, vectors.get(content), top_position)
    added = []
    for fact in changes["add"]:
        saved = await memories_repo.add_with_vector(
            db, convo_id, fact["content"], fact["source_position"], vectors.get(fact["content"]))
        if saved:
            added.append(saved)
    return added


async def _run(db: aiosqlite.Connection, convo_id: str, hold_back: int) -> dict:
    convo = await convo_repo.get(db, convo_id, with_messages=False)
    if not convo:
        raise NotFoundError("Conversation not found.", "conversation")
    character = await characters_repo.get_raw(db, convo["character_id"]) or {}
    persona = await personas_repo.for_conversation(db, convo)

    connection = await _resolve_connection(db, convo)

    messages = await convo_repo.list_messages(db, convo_id)
    # A reply still being written is read once it is finished, and what follows it with it.
    writing = next((i for i, m in enumerate(messages) if m["meta"].get("streaming")), len(messages))
    messages = messages[:min(writing, max(0, len(messages) - hold_back))]
    existing = await memories_repo.list_for_conversation(db, convo_id)
    built = build_extraction_payload(character, persona, convo, messages, existing)
    if built is None:
        return {"facts_added": [], "summary": convo.get("summary") or ""}
    payload, top_position = built
    read = [m["id"] for m in messages]  # the newest of them is the one at top_position
    sent = {(m["id"], m["content"]) for m in existing}

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
    vectors = await _vectors_of(answer_texts(parsed))

    # Nothing is kept of turns cut, or of facts edited or forgotten, while the model answered.
    async with write_transaction(db):
        current = await convo_repo.get(db, convo_id, with_messages=False)
        now = await memories_repo.list_for_conversation(db, convo_id)
        if (await convo_repo.message_ids_through(db, convo_id, top_position) != read
                or not sent <= {(m["id"], m["content"]) for m in now}):
            raise AppError("The conversation changed while the model read it.", 409,
                           kind=CONVERSATION_CHANGED)
        changes = plan_memory_changes(parsed, now, top_position)
        added = await _apply(db, convo_id, changes, vectors, top_position)
        # A summary typed meanwhile stays, and holds none of these turns: the next pass reads them.
        typed = current["summary"] != convo["summary"]
        if not typed:
            await convo_repo.remember(db, convo_id, top_position, changes["summary"])

    return {"facts_added": added,
            "summary": current["summary"] if typed else changes["summary"] or current["summary"]}


async def fill_vectors() -> None:
    """Startup task: load the model, the only place a download can happen, then give every
    fact and message that has no vector its own. Own connection; never raises."""
    if not await embeddings.warmup():
        return
    db = await _connect()
    try:
        for fact in await memories_repo.list_missing_embeddings(db):
            vectors = await embeddings.embed([fact["content"]], kind="passage")
            if vectors:
                await memories_repo.set_embedding(db, fact["id"], fact["content"],
                                                  embeddings.pack(vectors[0]))
        for message in await convo_repo.list_messages_missing_embeddings(db):
            vectors = await embeddings.embed([active_content(message)], kind="passage")
            if vectors:
                await convo_repo.set_message_embedding(db, message["id"], embeddings.pack(vectors[0]))
    except Exception:
        logger.exception("semantic memory: filling the missing vectors failed")
    finally:
        await db.close()
