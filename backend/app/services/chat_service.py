"""One chat turn: the person's message saved, then the reply written as it arrives.

Modes:
  send        — save the person's message, write its reply.
  regenerate  — last message a reply: add a version of it (history excludes it);
                last message the person's: write the reply it is missing.
  continue    — extend the version of the last reply that is on screen.

A version is cut short (``meta.interrupted``) from its first write until its last says it is whole;
the person's message is ``unanswered`` (``true``, or how the model failed) until its reply exists
or the person stops the turn.
"""

import asyncio
import logging
import re
import time
from contextlib import aclosing

import aiosqlite

from ..errors import MODEL_EMPTY, MODEL_ERROR, NO_CONNECTION, AppError, NotFoundError
from ..models.schemas import ChatRequest
from ..prompting import embeddings, retrieval
from ..prompting.engine import (
    active_content,
    build_chat_payload,
    is_out_of_character,
    trim_reply,
)
from ..prompting.payloads import build_impersonate_payload
from ..prompting.tokens import estimate_tokens
from ..providers import ProviderError, complete, get_provider
from ..repositories import characters as characters_repo
from ..repositories import connections as connections_repo
from ..repositories import conversations as convo_repo
from ..repositories import lore as lore_repo
from ..repositories import memories as memories_repo
from ..repositories import personas as personas_repo
from ..repositories import settings as settings_repo
from ..repositories.base import new_id
from . import memory_service
from .llm_json import describe_answer

logger = logging.getLogger(__name__)

# A reply in progress is saved this often: a server going down loses a second of it at most.
_FLUSH_SECONDS = 1.0
# What the context bar above the conversation shows of the last reply's prompt.
_CONTEXT_SHOWN = ("used_tokens", "budget", "context_size", "messages_included", "messages_total",
                  "lore_matched")
_CONTINUE_INSTRUCTION = (
    "[Continue your previous reply exactly where it stopped. Do not repeat anything, "
    "do not start over — just keep going seamlessly.]"
)


def message_sent_as(messages: list[dict], client_id: str | None) -> dict | None:
    if not client_id:
        return None
    return next((m for m in messages if (m.get("meta") or {}).get("client_id") == client_id), None)


def _auto_title(content: str) -> str:
    """Conversation title from the first user message, RP markup stripped."""
    # Bounded first: these patterns are quadratic on a long run of unclosed brackets.
    content = content[:1000]
    text = re.sub(r"\*[^*]*\*", " ", content)
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" \"'«»*")
    if not text:
        text = re.sub(r"[*\[\]]+", " ", content)
        text = re.sub(r"\s+", " ", text).strip()
    return text[:60]


async def _resolve(db: aiosqlite.Connection, convo_id: str):
    convo = await convo_repo.get(db, convo_id, with_messages=False)
    if not convo:
        raise NotFoundError("Conversation not found.", "conversation")
    character = await characters_repo.get(db, convo["character_id"])
    if not character:
        raise NotFoundError("Character not found.", "character")
    persona = await personas_repo.for_conversation(db, convo)
    connection = await connections_repo.resolve(db, convo.get("connection_id"))
    if connection is None:
        raise AppError("No LLM connection configured. Add one in Settings → LLM connections.",
                       kind=NO_CONNECTION)
    settings = await settings_repo.get_all(db)
    return convo, character, persona, connection, settings


def _cut_short(message: dict) -> list[int]:
    """Which versions of a reply were cut short, by their index."""
    return (message.get("meta") or {}).get("interrupted") or []


async def run_turn(db: aiosqlite.Connection, request: ChatRequest, turn) -> dict | None:
    """Writes one reply, and says how it ended if it failed or added nothing. A request it cannot
    run raises before anything is saved."""
    convo, character, persona, connection, settings = await _resolve(db, request.conversation_id)
    char_name = character.get("name") or "Character"
    user_name = (persona or {}).get("name") or "User"
    messages = await convo_repo.list_messages(db, convo["id"])

    answering = None  # the person's message, when the reply is a new one
    target = None  # the reply that gets a new version, or more of the one it has
    continue_mode = request.mode == "continue"
    if request.mode == "send":
        content = (request.content or "").strip()
        if not content:
            raise AppError("Empty message.", kind="empty_message")
        answering = message_sent_as(messages, request.client_id)
        if answering is not None and messages[-1] is not answering:
            turn.user_message = answering
            return None  # it has its reply, or others were sent since and a reply would answer them
        if answering is None:
            meta = {"unanswered": True}
            if request.message_mode in ("narrate", "ooc"):
                meta["mode"] = request.message_mode
            if request.client_id:
                meta["client_id"] = request.client_id
            answering = await convo_repo.add_message(db, convo["id"], "user", [content], meta=meta)
            if not (convo.get("title") or "").strip() and request.message_mode == "say":
                await convo_repo.update(db, convo["id"], {"title": _auto_title(content)})
            messages = messages + [answering]
        history = messages
    elif request.mode == "regenerate":
        if not messages:
            raise AppError("Nothing to regenerate.", kind="nothing_to_regenerate")
        if messages[-1]["role"] == "assistant":
            if not any(m["role"] == "user" for m in messages[:-1]):
                raise AppError("Nothing to regenerate: send a message first.",
                               kind="nothing_to_regenerate")
            target = messages[-1]
            history = messages[:-1]
        else:
            answering = messages[-1]
            history = messages
    else:
        if not messages or messages[-1]["role"] != "assistant":
            raise AppError("Nothing to continue: the last message is not a reply.",
                           kind="nothing_to_continue")
        target = messages[-1]
        history = messages + [{"role": "user", "variants": [_CONTINUE_INSTRUCTION],
                               "position": target["position"] + 1}]

    async def say_unanswered(why) -> None:
        """Whether the person's message still waits for its reply, and why, for a later page."""
        nonlocal answering
        meta = {k: v for k, v in answering["meta"].items() if k != "unanswered"}
        if why is not None:
            meta["unanswered"] = why
        if meta != answering["meta"]:
            answering = await convo_repo.update_message(db, answering["id"], meta=meta) or answering

    if answering is not None:
        await say_unanswered(True)
    turn.user_message = answering
    turn.message_id = target["id"] if target else new_id()
    existing = target["variants"][target["active_index"]] if continue_mode else ""
    turn.text = existing
    turn.accepted.set()

    memories = await memories_repo.list_for_conversation(db, convo["id"])
    lore_entries = await lore_repo.list_for_character(db, character["id"])

    # Facts ranked by relevance to the last two turns; without semantic memory, by recency.
    scene = "\n".join(active_content(m) for m in history[-2:])
    embedding_map = await memories_repo.list_embeddings(db, convo["id"])
    relevance_scores = await retrieval.rank(scene, embedding_map)

    def _build(passages=None, fold_leading_assistant=False):
        return build_chat_payload(
            character=character, persona=persona, conversation=convo,
            messages=history, connection=connection,
            global_instructions=settings.get("global_instructions") or "",
            memories=memories, lore_entries=lore_entries,
            reply_length=settings.get("reply_length") or "medium",
            history_limit=int(settings.get("history_limit") or 0),
            relevance_scores=relevance_scores,
            retrieved_passages=passages,
            fold_leading_assistant=fold_leading_assistant,
        )

    payload = _build()  # pass 1 — exposes oldest_visible / fact_positions

    passages = None
    passage_budget = int(settings.get("passage_budget") or 0)
    if passage_budget and scene:
        candidates = [m for m in history if m["position"] < payload.stats["oldest_visible"]
                      and not is_out_of_character(m)]
        if candidates:
            msg_emb = await convo_repo.list_message_embeddings(db, convo["id"])
            for m in candidates:  # lazy-fill vectors for newly out-of-window messages
                # Hundreds of them can each be a request: a stop does not wait for them.
                if turn.stopped:
                    break
                if m["id"] not in msg_emb:
                    text = active_content(m)
                    vecs = await embeddings.embed([text], kind="passage")
                    if vecs:
                        blob = embeddings.pack(vecs[0])
                        if await convo_repo.set_message_embedding(db, m["id"], blob):
                            msg_emb[m["id"]] = blob
            cand_map = {m["id"]: msg_emb[m["id"]] for m in candidates if m["id"] in msg_emb}
            scores = None if turn.stopped else await retrieval.rank(scene, cand_map)
            if scores:
                passages = retrieval.select_passages(
                    scores, candidates, passage_budget,
                    exclude_positions=set(payload.stats["fact_positions"]))
                if passages:
                    payload = _build(passages)  # pass 2 — inject RELEVANT PAST

    chunks: list[str] = []
    usage = None
    first_token_at = None
    started_at = time.monotonic()
    index = (target["active_index"] if continue_mode else len(target["variants"])) if target else 0
    others = set(_cut_short(target)) - {index} if target else set()
    written = False

    async def read_model() -> None:
        """Touches no database, so that a stop, which cancels it, cannot land in a write."""
        nonlocal usage, first_token_at
        async with aclosing(get_provider(connection).stream_chat(payload)) as stream:
            async for event in stream:
                if event.type == "done":
                    usage = event.usage
                    continue
                if event.type != "delta":
                    continue  # reasoning is no word of the reply, nor its first
                first_token_at = first_token_at or time.monotonic()
                if not chunks and existing[-1:].strip() and event.text[:1].strip():
                    turn.add(" ")  # as the version is saved
                chunks.append(event.text)
                turn.add(event.text)

    async def save(ending: dict | None = None) -> None:
        """What has arrived, cut short unless ``ending`` says how a whole version ended."""
        nonlocal written
        body = trim_reply("".join(chunks), char_name=char_name, user_name=user_name)
        if not body:
            return
        marks = sorted(others if ending is not None else others | {index})
        meta = {k: v for k, v in (target["meta"] if target else {}).items() if k != "interrupted"}
        meta.update(ending or {})
        if marks:
            meta["interrupted"] = marks
        if target:
            variants = list(target["variants"])
            if continue_mode:
                joiner = "" if not existing or existing[-1].isspace() or body[0].isspace() else " "
                variants[index] = existing + joiner + body
            else:
                variants.append(body)
            await convo_repo.update_message(db, target["id"], variants=variants, active_index=index,
                                            meta=meta, reread=True)
        elif written:
            await convo_repo.update_message(db, turn.message_id, variants=[body], meta=meta)
        else:
            await convo_repo.add_message(db, convo["id"], "assistant", [body], meta=meta,
                                         message_id=turn.message_id)
            if answering is not None:
                await say_unanswered(None)
        written = True

    # At most two passes: a model that answers nothing to a story opening on the greeting is asked
    # again with it folded into the system prompt (see build_chat_payload).
    error = None
    for attempt in (0, 1):
        if turn.stopped:
            break
        turn.reading = asyncio.create_task(read_model())
        while not turn.reading.done():
            await asyncio.wait({turn.reading}, timeout=_FLUSH_SECONDS)
            if not turn.reading.done():
                await save()
        error = None if turn.reading.cancelled() else turn.reading.exception()
        # Refusing the greeting may be said in the stream rather than by silence.
        refused = isinstance(error, ProviderError) and error.kind == MODEL_ERROR and not error.status
        if not (attempt == 0 and not chunks and not continue_mode and not turn.stopped
                and (error is None or refused)
                and payload.messages and payload.messages[0]["role"] == "assistant"):
            break
        payload = _build(passages, fold_leading_assistant=True)

    text = trim_reply("".join(chunks), char_name=char_name, user_name=user_name)
    if error is not None and not isinstance(error, ProviderError):
        await save()  # what arrived is kept before whatever broke is told
        raise error
    failure = {"kind": error.kind, "message": error.message} if error else None
    if turn.stopped or failure is not None:
        # What arrived is the reply as far as it goes, every word of it.
        await save()
        if not text and answering is not None:
            await say_unanswered(None if turn.stopped else failure)
        return None if turn.stopped else failure
    if not text:
        if continue_mode:
            return {"kind": "nothing_added", "message": "The model had nothing to add."}
        failure = {"kind": MODEL_EMPTY,
                   "message": "The model returned an empty reply. Try again or switch models."}
        if answering is not None:
            await say_unanswered(failure)
        return failure

    now = time.monotonic()
    gen_seconds = now - (first_token_at or started_at)
    completion_tokens = None
    if isinstance(usage, dict):
        completion_tokens = usage.get("completion_tokens") or usage.get("output_tokens")
    if not completion_tokens:
        completion_tokens = estimate_tokens("".join(chunks))
    perf = {
        "gen_seconds": round(now - started_at, 2),
        "first_token_seconds": round((first_token_at or now) - started_at, 2),
        "tokens_per_s": round(completion_tokens / gen_seconds, 1) if gen_seconds > 0.2 else None,
    }
    await save({"perf": perf, "context": {key: payload.stats[key] for key in _CONTEXT_SHOWN}})
    await convo_repo.touch(db, convo["id"])
    memory_service.schedule_if_due(convo["id"])
    return None


async def impersonate(db: aiosqlite.Connection, convo_id: str) -> dict:
    """Ghost-write the player's next message. Returns {"text": ...}."""
    convo, character, persona, connection, _ = await _resolve(db, convo_id)
    char_name = character.get("name") or "Character"
    user_name = (persona or {}).get("name") or "User"
    messages = await convo_repo.list_messages(db, convo_id)
    if not messages:
        raise AppError("Nothing to write: the conversation is empty.", kind="conversation_empty")

    payload = build_impersonate_payload(character, persona, convo, messages, connection)
    answer = await complete(get_provider(connection), payload)
    text = trim_reply(answer, char_name=user_name, user_name=char_name)
    if not text:
        logger.warning("impersonation: empty answer, %s", describe_answer(answer))
        raise AppError("The model did not suggest anything. Try again.", 502, kind=MODEL_EMPTY)
    return {"text": text}
