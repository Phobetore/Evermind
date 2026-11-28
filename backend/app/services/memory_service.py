"""Self-maintained long-term memory.

A pass is due once MAINTENANCE_EVERY assistant replies are unread: one LLM call (the
conversation's own connection) extracts new durable facts and rewrites the running summary to
cover what it read. An automatic pass leaves the newest HOLD_BACK messages unread, and the
replies among them count toward the next one: with the player and the character taking turns,
the first pass comes after MAINTENANCE_EVERY replies and each later one HOLD_BACK / 2 replies
earlier, after 8 and then every 6.
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
    NO_AI_MESSAGE,
    NO_CONNECTION,
    NOT_FOUND,
    TOO_FEW_FACTS,
    AppError,
    NotFoundError,
    error_body,
)
from ..prompting import embeddings
from ..prompting.engine import PromptPayload, active_content
from ..prompting.memory_changes import answer_texts, plan_consolidation, plan_memory_changes
from ..prompting.payloads import (
    CONTEXT_MARGIN,
    MIN_FACTS_TO_CONSOLIDATE,
    build_consolidation_payload,
    build_extraction_payload,
    movable_facts,
    prompt_tokens,
)
from ..providers import Answer, ProviderError, complete_answer, get_provider
from ..providers.base import NO_TEXT, REFUSED_AS_WRITTEN, STOPPED_FOR_LENGTH, unwritten
from ..repositories import characters as characters_repo
from ..repositories import conversations as convo_repo
from ..repositories import memories as memories_repo
from ..repositories import models as models_repo
from ..repositories import personas as personas_repo
from ..repositories import settings as settings_repo
from . import calls
from . import turns as chat_turns
from .ai_call import call_for, reply_room
from .llm_json import describe_answer, parse_llm_json

logger = logging.getLogger(__name__)

MAINTENANCE_EVERY = 8  # unread assistant replies that make a pass due
HOLD_BACK = 4  # newest messages an automatic pass leaves unread: a reply may still be thrown away

MIN_ANSWER_TOKENS = 2048  # a pass's JSON is cut, and unreadable, in less than this
# A model that reasons before it writes needs room for both: the second ask of a pass that ran out.
MORE_ROOM_TOKENS = 8192

# The operation under way for a conversation: "pass" (automatic), "extract" or "consolidate".
_running: dict[str, str] = {}
# Conversations whose pass or Condense failed: the error body of each ("pass", "consolidate"), the
# newest ("last"), and how many replies the automatic pass waits before it tries again ("left").
_failed: dict[str, dict] = {}
# Every operation the server runs: none belongs to a request, and the server's stop ends them.
_tasks: set[asyncio.Task] = set()
# Refusals that say nothing failed in the memory: another operation ran, what it read changed, or
# there was too little to merge. Whoever asked is told; nothing is kept of them.
_NOT_FAILURES = (MEMORY_BUSY, CONVERSATION_CHANGED, FACTS_CHANGED, TOO_FEW_FACTS, NOT_FOUND)
# The max_tokens a second ask read with, by AI id and model: where the next pass starts,
# so that a model that needs more room pays one call, not two. Lost at restart, on purpose.
_learned: dict[tuple[str, str], int] = {}


def is_running(convo_id: str) -> bool:
    """Whether a pass, a Remember or a consolidation is under way for the conversation."""
    return convo_id in _running


def operation_of(convo_id: str) -> str | None:
    """Which one, for a page that opens while it runs and shows it as if asked from there."""
    return _running.get(convo_id)


def _own(work: Awaitable[dict | None]) -> asyncio.Task:
    task = asyncio.get_running_loop().create_task(work)
    _tasks.add(task)
    task.add_done_callback(_forget)
    return task


def _forget(task: asyncio.Task) -> None:
    _tasks.discard(task)
    # Read, so that asyncio does not report it: its asker was told, or its failure is kept.
    if not task.cancelled():
        task.exception()


async def stop() -> None:
    """At the server's stop. What an operation writes is one transaction, rolled back whole when
    it is cancelled, so none is left half-written."""
    for task in list(_tasks):
        task.cancel()
    await asyncio.gather(*_tasks, return_exceptions=True)


async def asked(convo_id: str, operation: str) -> dict:
    """A Remember ("extract") or a consolidation someone asked for, run by a task of the server's
    own, as a reply is: the asker gets its answer as before, but a page that goes away, and the
    request it leaves, cancel nothing. A failure is kept for the conversation to tell, since its
    asker may be gone, until an operation succeeds."""
    return await asyncio.shield(_own(_asked(convo_id, operation)))


async def _asked(convo_id: str, operation: str) -> dict:
    db = await _connect()
    try:
        if operation == "extract":
            result = await run_maintenance(db, convo_id, hold_back=0, operation="extract")
            result = {**result, "memories": await memories_repo.list_for_conversation(db, convo_id)}
        else:
            result = await consolidate(db, convo_id)
    except AppError as exc:
        if exc.kind not in _NOT_FAILURES:
            _keep(convo_id, _slot(operation), {**error_body(exc), "operation": operation})
        raise
    except Exception:
        _keep(convo_id, _slot(operation),
              {"error": "The memory task failed.", "kind": "internal", "operation": operation})
        raise
    finally:
        await db.close()
    if operation == "consolidate":
        # A Condense that succeeds says nothing of whether a pass would: it clears only its own.
        # A Remember that succeeds is a pass, and run_maintenance has cleared the pass's.
        _keep(convo_id, "consolidate", None)
    return result


def _keep(convo_id: str, slot: str, body: dict | None, left: int | None = None) -> None:
    """Keep why the pass ("pass": the automatic one or a Remember, the same work) or a Condense
    ("consolidate") failed, or forget it with no body. Each is kept apart, for a success of one
    to say nothing of the other; the newest is told. ``left`` is the automatic pass's wait, which
    an operation asked for neither shortens nor starts."""
    entry = _failed.setdefault(convo_id, {"left": 0})
    if left is not None:
        entry["left"] = left
    if body is None:
        entry.pop(slot, None)
    else:
        entry[slot] = body
        entry["last"] = slot
    if "pass" not in entry and "consolidate" not in entry and entry["left"] <= 0:
        _failed.pop(convo_id, None)


def failure_of(convo_id: str) -> dict | None:
    """Why the pass or a Condense last failed, shaped as an error response with the operation that
    failed ("pass", "extract" or "consolidate"), until that work succeeds."""
    failed = _failed.get(convo_id) or {}
    return failed.get(failed.get("last") or "") or failed.get("pass") or failed.get("consolidate")


def _slot(operation: str) -> str:
    return "consolidate" if operation == "consolidate" else "pass"


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
            if exc.kind in (MEMORY_BUSY, CONVERSATION_CHANGED, FACTS_CHANGED):
                return  # the next reply asks again
            logger.warning("memory maintenance failed for %s: %s", convo_id, exc.message)
            _keep(convo_id, "pass", {**error_body(exc), "operation": "pass"}, MAINTENANCE_EVERY - 1)
        except Exception:
            logger.exception("memory maintenance failed for %s", convo_id)
            _keep(convo_id, "pass", {"error": "The memory pass failed.", "kind": "internal",
                                     "operation": "pass"}, MAINTENANCE_EVERY - 1)
        finally:
            await db.close()

    _own(_task())


async def one_at_a_time(convo_id: str, work: Callable[[], Awaitable[dict]],
                        operation: str = "pass") -> dict:
    """Run ``work``, unless another memory task is running for this conversation. A pass and a
    consolidation each read the memory, wait for a model, and write what it said, so that the
    two would cross."""
    if convo_id in _running:
        raise AppError("Another memory task is running.", 409, kind=MEMORY_BUSY)
    _running[convo_id] = operation
    try:
        return await work()
    finally:
        _running.pop(convo_id, None)
        # It wrote inside the process, never through the API, and its calls are counted: the
        # end of a turn read before it says neither what the story is nor what it cost.
        chat_turns.wrote()


async def run_maintenance(db: aiosqlite.Connection, convo_id: str,
                          hold_back: int = HOLD_BACK, operation: str = "pass") -> dict:
    """One extraction+summary pass, which leaves the ``hold_back`` newest messages for the
    next. Returns {"facts_added": [...], "summary": str}."""
    async def work() -> dict:
        result = await _run(db, convo_id, hold_back)
        _keep(convo_id, "pass", None, 0)
        return result

    return await one_at_a_time(convo_id, work, operation)


async def _resolve_connection(db: aiosqlite.Connection, convo: dict
                              ) -> tuple[dict, tuple[dict, dict]]:
    """The call a pass makes, and the AI it is made on (model, service), which its rows name."""
    resolved = await models_repo.resolve(db, convo.get("model_id"))
    if resolved is None:
        raise AppError(NO_AI_MESSAGE, kind=NO_CONNECTION)
    model, service = resolved
    settings = await settings_repo.get_all(db)
    # Its prompts are not the engine's: the provider is given the call itself.
    call = call_for(model, service, room=reply_room(convo, settings))
    # A pass writes JSON, which reasoning does not improve, and every token of it is paid for.
    call = {**call, "least_reasoning": True}
    if call.get("max_tokens"):
        call = {**call, "max_tokens": max(call["max_tokens"], MIN_ANSWER_TOKENS)}
    return call, (model, service)


async def _learn_if_it_thought(db: aiosqlite.Connection, call: dict, answer: Answer) -> None:
    """An answer that came with reasoning says its AI reasons, whether or not it reads."""
    if answer.thought > 0:
        await models_repo.learn_reasons(db, call["model_id"], call["model"])


async def _ask(connection: dict, payload: PromptPayload, reads: Callable[[str], bool],
               what: str, *, ai: tuple[dict, dict], who: calls.Who
               ) -> tuple[Answer, str | None]:
    """The model's answer to a pass, asked again once, with more room, if it ran out of it; and
    the id of the row of the ask it came from, which the caller marks if it throws it away.

    A model that reasons before it writes can spend the whole ceiling thinking and answer nothing,
    and a JSON cut short is as unreadable. Either is a lack of room, not of will, so the second
    ask gives it more, never past what the context leaves, and the next pass starts there. The
    answer is returned whether it reads or not: ``_unreadable`` says why it did not."""
    own = connection.get("max_tokens") or 0
    # Per AI: two AIs of one model on two services each learn their own room.
    key = (connection.get("model_id") or "", connection.get("model") or "")
    left = None
    if context := connection.get("context_size"):
        left = context - prompt_tokens(payload) - CONTEXT_MARGIN
    first = own
    if (learned := _learned.get(key, 0)) > own:
        first = max(own, learned if left is None else min(learned, left))
    estimate = prompt_tokens(payload)

    async def asked(call: dict, attempt: int) -> tuple[Answer, str | None]:
        # Each ask is a request of its own, and its own row.
        provider = get_provider(call)
        async with calls.recording(provider, ai, who, attempt=attempt,
                                   prompt_estimate=estimate) as recording:
            answer = await complete_answer(provider, payload)
            recording.mark("whole" if answer.text.strip() else "empty")
        return answer, recording.row_id

    if first == own:
        answer, row = await asked(connection, 0)
    else:
        try:
            answer, row = await asked({**connection, "max_tokens": first}, 0)
        except ProviderError as exc:
            if exc.status not in REFUSED_AS_WRITTEN:
                raise
            # Its server's limit came down since: this AI's own reply ceiling is where to start,
            # and this ask is the pass's second, so it is not followed by another.
            _learned.pop(key, None)
            logger.warning("%s: max_tokens %d, learned on an earlier pass, was refused (%s); "
                           "asking with this AI's own.", what, first, exc.message)
            return await asked(connection, 1)
    if reads(answer.text):
        return answer, row
    ran_out = answer.stop == STOPPED_FOR_LENGTH or (
        not answer.text.strip() and answer.thought > 0 and first > 0)
    if not ran_out:
        return answer, row
    room = max(MORE_ROOM_TOKENS, 4 * first)
    if left is not None:
        room = min(room, left)
    # With no ceiling sent, the server's own default ran out, and it may be above a smaller one.
    if room <= first or (not first and room < MORE_ROOM_TOKENS):
        return answer, row
    logger.warning("%s: the model ran out of room (%d characters of reasoning, stopped with %r, "
                   "max_tokens %s); asking again with %d. Raising this AI's reply ceiling "
                   "avoids the second call.", what, answer.thought, answer.stop, first or "unset",
                   room)
    try:
        second, second_row = await asked({**connection, "max_tokens": room}, 1)
    except ProviderError as exc:
        # A server whose output limit is lower refuses it: the first answer's failure stands.
        logger.warning("%s: the second ask was refused: %s", what, exc.message)
        return answer, row
    except BaseException:
        # Cut (the server stopping) or failed: the pass ends here, and the first answer is lost
        # with it. Shielded, so that a cancel does not cut the mark as well.
        await asyncio.shield(calls.discard(row))
        raise
    # The first answer was thrown away for this one.
    await calls.discard(row)
    if reads(second.text):
        _learned[key] = room
    return second, second_row


async def _thrown_away(exc: AppError, row: str | None) -> None:
    """An answer refused because what it was read from changed: its row says it was thrown away.
    Marked once the transaction is over: it held the database the mark is written to."""
    if exc.kind in (CONVERSATION_CHANGED, FACTS_CHANGED):
        await calls.discard(row)


def _unreadable(answer: Answer, what: str, said: str) -> AppError:
    """Why a pass has nothing to use, by how the model's answer ended: it only thought or ran out
    of room, its server withheld it, it gave no text, or what it wrote cannot be read."""
    logger.warning("%s: unreadable answer, %s, %d characters of reasoning, stopped with %r",
                   what, describe_answer(answer.text), answer.thought, answer.stop)
    if answer.text.strip():
        return AppError(said, 502, kind=MODEL_UNREADABLE)
    only_thought = ("The model only thought, and wrote no memory. Raise this AI's reply "
                    "ceiling, or use a model that thinks less.")
    return unwritten(answer, only_thought) or AppError("The model returned no text.", 502,
                                                       kind=NO_TEXT)


async def consolidate(db: aiosqlite.Connection, convo_id: str) -> dict:
    """Merge the model's unpinned facts into a shorter, denser set.
    Returns {"before": n, "after": n, "memories": [...]}."""
    return await one_at_a_time(convo_id, lambda: _consolidate(db, convo_id), "consolidate")


async def _consolidate(db: aiosqlite.Connection, convo_id: str) -> dict:
    convo = await convo_repo.get(db, convo_id, with_messages=False)
    if not convo:
        raise NotFoundError("Conversation not found.", "conversation")
    character = await characters_repo.get(db, convo["character_id"]) or {}
    connection, ai = await _resolve_connection(db, convo)
    persona = await personas_repo.for_conversation(db, convo)

    all_facts = await memories_repo.list_for_conversation(db, convo_id)
    movable = movable_facts(all_facts)
    if len(movable) < MIN_FACTS_TO_CONSOLIDATE:
        raise AppError("Too few facts to consolidate: only the model's unpinned facts are merged.",
                       409, kind=TOO_FEW_FACTS)

    payload = build_consolidation_payload(character, persona, movable)

    def merge(text: str) -> dict | None:
        return plan_consolidation(parse_llm_json(text), movable)

    what = "consolidation"
    answer, row = await _ask(connection, payload, lambda text: merge(text) is not None, what,
                             ai=ai, who=calls.for_conversation("consolidation", convo, character))
    await _learn_if_it_thought(db, connection, answer)
    merged = merge(answer.text)
    if merged is None:
        await calls.discard(row)
        raise _unreadable(answer, what, "Unreadable consolidation — try again.")

    vectors = await _vectors_of(merged["facts"])

    # Refused when a fact sent changed since: its old text may be inside a merged one. Its position
    # counts too, as a merged fact takes the oldest of those it replaces, which a cut may have moved.
    try:
        async with write_transaction(db):
            now = await memories_repo.list_for_conversation(db, convo_id)
            still = {(m["id"], m["content"], m["source_position"]) for m in movable_facts(now)}
            if any((m["id"], m["content"], m["source_position"]) not in still for m in movable):
                raise AppError("The facts changed while the model merged them.", 409,
                               kind=FACTS_CHANGED)

            # A fact the merge repeats stays as it is: adding it again is refused as a double.
            for content in merged["facts"]:
                await memories_repo.add_with_vector(db, convo_id, content,
                                                    merged["source_position"],
                                                    vectors.get(content))
            kept = set(merged["facts"])
            for m in movable:
                if m["content"] not in kept:
                    await memories_repo.remove(db, m["id"])
            remaining = await memories_repo.list_for_conversation(db, convo_id)
    except AppError as exc:
        await _thrown_away(exc, row)
        raise
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
    character = await characters_repo.get(db, convo["character_id"]) or {}
    persona = await personas_repo.for_conversation(db, convo)

    connection, ai = await _resolve_connection(db, convo)

    # A reply being written is read once finished, and what follows it: asked first, never half.
    turn = await chat_turns.running_for(convo_id)
    messages = await convo_repo.list_messages(db, convo_id)
    writing = next((i for i, m in enumerate(messages) if turn and m["id"] == turn.message_id),
                   len(messages))
    messages = messages[:min(writing, max(0, len(messages) - hold_back))]
    existing = await memories_repo.list_for_conversation(db, convo_id)
    built = build_extraction_payload(character, persona, convo, messages, existing)
    if built is None:
        return {"facts_added": [], "summary": convo.get("summary") or ""}
    payload, turns = built
    top_position = turns[-1]["position"]
    read = [m["id"] for m in messages]  # the story up to the newest of the turns, at top_position
    told = {(m["id"], m["content"]) for m in turns}  # what the model was told they say
    sent = {(m["id"], m["content"]) for m in existing}

    what = "memory extraction"
    answer, row = await _ask(connection, payload, lambda text: parse_llm_json(text) is not None,
                             what, ai=ai, who=calls.for_conversation("memory", convo, character))
    await _learn_if_it_thought(db, connection, answer)
    parsed = parse_llm_json(answer.text)
    if parsed is None:
        await calls.discard(row)
        raise _unreadable(answer, what, "Unreadable memory response (JSON expected).")
    vectors = await _vectors_of(answer_texts(parsed))

    # Nothing is kept of turns cut, or rewritten among those told, or of facts changed meanwhile.
    try:
        async with write_transaction(db):
            current = await convo_repo.get(db, convo_id, with_messages=False)
            now = await memories_repo.list_for_conversation(db, convo_id)
            story = await convo_repo.turns_through(db, convo_id, top_position)
            if [i for i, _ in story] != read or not told <= set(story):
                raise AppError("The conversation changed while the model read it.", 409,
                               kind=CONVERSATION_CHANGED)
            if not sent <= {(m["id"], m["content"]) for m in now}:
                raise AppError("A fact changed while the model read the story.", 409,
                               kind=FACTS_CHANGED)
            changes = plan_memory_changes(parsed, now, top_position)
            added = await _apply(db, convo_id, changes, vectors, top_position)
            # A summary typed meanwhile stays where it put the memory: the next pass reads these
            # turns.
            typed = current["summary"] != convo["summary"]
            if not typed:
                await convo_repo.remember(db, convo_id, top_position, changes["summary"])
    except AppError as exc:
        await _thrown_away(exc, row)
        raise

    return {"facts_added": added,
            "summary": current["summary"] if typed else changes["summary"] or current["summary"]}


# After each vector it stores, the start-up task lets any write waiting on the database go first.
_GIVE_WAY_S = 0.05


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
                await asyncio.sleep(_GIVE_WAY_S)
        for message in await convo_repo.list_messages_missing_embeddings(db):
            vectors = await embeddings.embed([active_content(message)], kind="passage")
            if vectors:
                await convo_repo.set_message_embedding(db, message["id"], embeddings.pack(vectors[0]))
                await asyncio.sleep(_GIVE_WAY_S)
    except Exception:
        logger.exception("semantic memory: filling the missing vectors failed")
    finally:
        await db.close()
