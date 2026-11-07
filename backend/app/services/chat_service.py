"""One chat turn, streamed end to end.

SSE wire contract (one `data: <json>` line per event):
  {"type":"start","conversation_id":...,"mode":"send|regenerate|continue",
   "user_message":{...}|null,"target_message_id":...|null}
  {"type":"delta","text":"..."}
  {"type":"done","message":{...MessageOut},"context":{...},"perf":{...}}
  (``nothing_added`` is true on a continuation that added nothing to the reply)
  {"type":"discarded"}
  (what the reply was being written into was deleted, so nothing came of it)
  {"type":"error","message":"...","kind":"...","resource":"..."}
  (``kind`` names the failure for the interface; ``resource`` only goes with
  "not_found", and says what was not found. A model's failure also carries
  what its server said: ``upstream``, ``upstream_status``, ``upstream_url``. The
  words that arrived before a model failed are kept, as when a turn is stopped.)
A turn that is stopped just ends, with neither ``done`` nor ``error``.

Modes:
  send        — persist the user message, generate the reply.
  regenerate  — last message assistant: add a new variant (history excludes it);
                last message user (after an error): generate the missing reply.
  continue    — extend the active variant of the last assistant message.
"""

import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator
from contextlib import aclosing

import aiosqlite

from ..db import write_transaction
from ..errors import (
    MODEL_EMPTY,
    MODEL_ERROR,
    NO_CONNECTION,
    NOT_FOUND,
    AppError,
    NotFoundError,
    failure_fields,
    model_failure,
)
from ..models.schemas import ChatRequest
from ..prompting import embeddings, retrieval
from ..prompting.engine import PromptPayload, active_content, build_chat_payload
from ..prompting.payloads import build_impersonate_payload, build_summary_payload
from ..prompting.tokens import estimate_tokens
from ..prompting.turn import (
    continue_history,
    passage_candidates,
    passage_infos,
    scene_of,
    trim_reply,
)
from ..providers import get_provider
from ..repositories import characters as characters_repo
from ..repositories import connections as connections_repo
from ..repositories import conversations as convo_repo
from ..repositories import lore as lore_repo
from ..repositories import memories as memories_repo
from ..repositories import personas as personas_repo
from ..repositories import settings as settings_repo
from . import memory_service

logger = logging.getLogger(__name__)

# How often a reply in progress is written to the database. Often enough that a
# server going down loses at most a second of text, rarely enough that a long reply
# costs a handful of writes rather than one per token.
_FLUSH_SECONDS = 1.0


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def ends_turn(chunk: str) -> bool:
    """Whether this event is the turn saying how it ended."""
    return chunk.startswith((
        'data: {"type": "done"', 'data: {"type": "error"', 'data: {"type": "discarded"',
    ))


def discards_turn(chunk: str) -> bool:
    """Whether this event is the turn saying that nothing came of it."""
    return chunk.startswith('data: {"type": "discarded"')


def message_sent_as(messages: list[dict], client_id: str | None) -> dict | None:
    """The message that a page sent under this id, if it is among these."""
    if not client_id:
        return None
    return next((m for m in messages if (m.get("meta") or {}).get("client_id") == client_id), None)


def said_already(conversation_id: str, message: dict, following: dict) -> list[str]:
    """What a turn for a message says when that turn is long over: the message, and
    the reply that came of it. With none, and others sent since, a reply now would
    answer the wrong thing, so nothing comes of it."""
    start = {"type": "start", "conversation_id": conversation_id, "mode": "send",
             "user_message": message, "target_message_id": None}
    ending = ({"type": "done", "message": following} if following["role"] == "assistant"
              else {"type": "discarded"})
    return [_sse(start), _sse(ending)]


def error_event(message: str, kind: str, resource: str | None = None, **details) -> str:
    """The event that ends a turn that could not be done. ``details`` are more
    fields for the interface, such as what a model's server said."""
    event = {"type": "error", "message": message, "kind": kind}
    if resource:
        event["resource"] = resource
    return _sse({**event, **details})


def _auto_title(content: str) -> str:
    """Conversation title from the first user message, RP markup stripped."""
    # Bounded before any regex sees it. These patterns are quadratic on a long
    # run of unclosed brackets, and the result is sixty characters, so there is
    # nothing to gain from scanning a message that opens with an essay.
    content = content[:1000]
    text = re.sub(r"\*[^*]*\*", " ", content)
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" \"'«»*")
    if not text:
        text = re.sub(r"[*\[\]]+", " ", content)
        text = re.sub(r"\s+", " ", text).strip()
    return text[:60]


class _TurnError(Exception):
    """A turn that cannot start. ``kind`` and ``resource`` mean what they do in
    ``AppError``."""

    def __init__(self, message: str, kind: str, resource: str | None = None):
        super().__init__(message)
        self.message = message
        self.kind = kind
        self.resource = resource

    def as_app_error(self) -> AppError:
        if self.kind == NOT_FOUND:
            return NotFoundError(self.message, self.resource or "")
        return AppError(self.message, 400, kind=self.kind, resource=self.resource)


async def _resolve(db: aiosqlite.Connection, convo_id: str):
    convo = await convo_repo.get(db, convo_id, with_messages=False)
    if not convo:
        raise _TurnError("Conversation not found.", NOT_FOUND, "conversation")
    character = await characters_repo.get_raw(db, convo["character_id"])
    if not character:
        raise _TurnError("Character not found.", NOT_FOUND, "character")
    persona = await personas_repo.for_conversation(db, convo)
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
        raise _TurnError(
            "No LLM connection configured. Add one in Settings → LLM connections.",
            NO_CONNECTION,
        )
    settings = await settings_repo.get_all(db)
    return convo, character, persona, connection, settings


async def _generate(connection: dict, payload: PromptPayload):
    provider = get_provider(connection)
    # Closed here and now whichever way this ends, rather than whenever the garbage
    # collector comes round, which is how long the request to the model would last.
    async with aclosing(provider.stream_chat(payload)) as stream:
        async for event in stream:
            yield event


async def _until_stopped(events: AsyncIterator, stopped: asyncio.Event) -> AsyncIterator:
    """A model's events, until someone says stop, which ends the request to it there
    and then rather than at its next word: on a local model with a long prompt, that
    can be minutes away.

    Only the waiting for the model is interrupted. What is done with each event never
    is, so a stop cannot land in the middle of writing to the database. The model is
    read on a task of its own, since it is that task which gets cancelled, and
    everything of a request to a model happens on one task, as its client expects.
    """
    if stopped.is_set():
        return
    queue: asyncio.Queue = asyncio.Queue()
    finished = object()

    async def read() -> None:
        try:
            async with aclosing(events) as stream:
                async for event in stream:
                    queue.put_nowait(event)
        except Exception as exc:  # noqa: BLE001 - it belongs to whoever is reading
            queue.put_nowait(exc)
        finally:
            queue.put_nowait(finished)

    reading = asyncio.create_task(read())
    stop_said = asyncio.create_task(stopped.wait())
    try:
        while not stopped.is_set():
            arrived = asyncio.create_task(queue.get())
            await asyncio.wait({arrived, stop_said}, return_when=asyncio.FIRST_COMPLETED)
            if not arrived.done():
                arrived.cancel()
                return
            item = arrived.result()
            if item is finished:
                return
            if isinstance(item, Exception):
                raise item
            yield item
    finally:
        stop_said.cancel()
        reading.cancel()
        await asyncio.wait({reading})


def _cut_short(message: dict) -> list[int]:
    """Which versions of a reply were cut short, by their index. An older reply says only
    that it was, of the whole message: that reads as the version active."""
    marks = (message.get("meta") or {}).get("interrupted")
    if marks is True:
        return [message["active_index"]]
    return marks if isinstance(marks, list) else []


async def _settle_unfinished(db: aiosqlite.Connection, messages: list[dict]) -> list[dict]:
    """Turn a stale "still writing" mark into what it actually means.

    The mark says a turn is writing that message right now. A turn that ends
    before its reply is complete, because it was stopped, the model failed or
    the server went down, never clears it, so it outlives the turn.

    By the time another turn starts, nothing is writing it any more. Settle it
    as interrupted, which the view labels as such.
    """
    settled = []
    for message in messages:
        meta = message.get("meta") or {}
        if not meta.get("streaming"):
            settled.append(message)
            continue
        meta = {key: value for key, value in meta.items() if key != "streaming"}
        meta["interrupted"] = [message["active_index"]]
        settled.append(await convo_repo.update_message(db, message["id"], meta=meta) or message)
    return settled


async def stream_turn(db: aiosqlite.Connection, request: ChatRequest,
                      stopped: asyncio.Event | None = None) -> AsyncIterator[str]:
    stopped = stopped or asyncio.Event()
    try:
        convo, character, persona, connection, settings = await _resolve(db, request.conversation_id)
    except _TurnError as exc:
        yield error_event(exc.message, exc.kind, exc.resource)
        return

    char_name = character.get("name") or "Character"
    user_name = (persona or {}).get("name") or "User"
    messages = await _settle_unfinished(db, await convo_repo.list_messages(db, convo["id"]))

    user_message = None
    answering = None  # the person's message this reply is an answer to, if it is a new one
    target_message = None  # existing assistant message receiving a new/extended variant
    continue_mode = False

    if request.mode == "send":
        content = (request.content or "").strip()
        if not content:
            yield error_event("Empty message.", "empty_message")
            return
        # Here already if it is being sent again, and turns.py has seen that what it
        # is missing is its reply. That is all there is to do about it.
        user_message = message_sent_as(messages, request.client_id)
        if user_message is None:
            # From the start, so that it is still said if the server dies before the
            # reply comes. turns.py takes it away when the turn ends with one.
            message_meta = {"unanswered": True}
            if request.message_mode in ("narrate", "ooc"):
                message_meta["mode"] = request.message_mode
            if request.client_id:
                message_meta["client_id"] = request.client_id
            user_message = await convo_repo.add_message(db, convo["id"], "user", [content],
                                                        meta=message_meta)
            if not (convo.get("title") or "").strip() and request.message_mode == "say":
                await convo_repo.update(db, convo["id"], {"title": _auto_title(content)})
            messages = messages + [user_message]
        elif not user_message["meta"].get("unanswered"):
            await convo_repo.update_message(
                db, user_message["id"], meta={**user_message["meta"], "unanswered": True})
        answering = user_message
        history = messages
    elif request.mode == "regenerate":
        if not messages:
            yield error_event("Nothing to regenerate.", "nothing_to_regenerate")
            return
        last = messages[-1]
        if last["role"] == "assistant":
            if not any(m["role"] == "user" for m in messages[:-1]):
                yield error_event("Nothing to regenerate: send a message first.",
                                  "nothing_to_regenerate")
                return
            target_message = last
            history = messages[:-1]
        else:
            answering = last
            history = messages
    elif request.mode == "continue":
        if not messages or messages[-1]["role"] != "assistant":
            yield error_event("Nothing to continue: the last message is not a reply.",
                              "nothing_to_continue")
            return
        target_message = messages[-1]
        continue_mode = True
        history = continue_history(messages)
    else:  # the request schema lets only the three modes above through
        yield error_event(f"Unknown mode: {request.mode}", "internal")
        return

    memories = await memories_repo.list_for_conversation(db, convo["id"])
    lore_entries = await lore_repo.list_for_character(db, character["id"])

    # Semantic recall: rank out-of-window facts by relevance to the live scene
    # (the last couple of turns). Falls back to recency when embeddings are off.
    scene = scene_of(history)
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

    # Bound here rather than only inside the branch below: a retry has to rebuild
    # with whatever passages this turn settled on, and semantic recall being off
    # must not leave the name undefined.
    passages = None
    passage_budget = int(settings.get("passage_budget") or 0)
    if passage_budget and scene:
        candidates, fact_positions = passage_candidates(history, payload.stats)
        if candidates:
            msg_emb = await convo_repo.list_message_embeddings(db, convo["id"])
            for m in candidates:  # lazy-fill vectors for newly out-of-window messages
                # There can be hundreds of these, each one a request of its own, and
                # a stop should not have to wait for them.
                if stopped.is_set():
                    break
                if m["id"] not in msg_emb:
                    text = active_content(m)
                    vecs = await embeddings.embed([text], kind="passage")
                    if vecs:
                        blob = embeddings.pack(vecs[0])
                        if await convo_repo.set_message_embedding(db, m["id"], text, blob):
                            msg_emb[m["id"]] = blob
            cand_map = {m["id"]: msg_emb[m["id"]] for m in candidates if m["id"] in msg_emb}
            scores = None if stopped.is_set() else await retrieval.rank(scene, cand_map)
            if scores:
                infos = passage_infos(candidates, cand_map)
                passages = retrieval.select_passages(scores, infos, passage_budget,
                                                     exclude_positions=fact_positions)
                if passages:
                    payload = _build(passages)  # pass 2 — inject RELEVANT PAST

    # target_message_id says which reply this turn is replacing or extending, so
    # that a page arriving in the middle of one knows not to show that reply and
    # its replacement at the same time.
    yield _sse({"type": "start", "conversation_id": convo["id"],
                "mode": request.mode,
                "user_message": user_message,
                "target_message_id": target_message["id"] if target_message else None})

    chunks: list[str] = []
    usage = None
    finish_reason = None
    first_token_at = None
    started_at = time.monotonic()
    retried_folded = False

    # The reply is written to the database while it streams, not only once it is
    # finished. A server that goes down leaves this generator anywhere: flushing
    # as it goes means whatever has arrived is already kept, without depending on
    # cleanup at all. A turn that is stopped writes what has arrived when it ends.
    draft_id: str | None = None
    flushed_at = 0.0
    # The message this reply answers or belongs to has been deleted, mid-turn, by the
    # person. There is nothing to write it into, and nothing further to generate.
    reply_gone = False

    async def persist(*, final: bool, failed: bool = False) -> dict | None:
        """Write what has streamed so far. Recomputed from the original variants
        every time, so calling it repeatedly is the same as calling it once.

        ``failed`` says the model failed: the version is marked as cut short at once, where
        a reply that was stopped is marked by the next turn, which is the one that knows it
        will not be finished. A continuation that adds to a version finishes it, and takes
        the mark away; one that adds nothing leaves it as cut short as it was."""
        nonlocal draft_id, reply_gone
        body = trim_reply("".join(chunks), char_name=char_name, user_name=user_name)
        if not body and not final:
            return None

        target_meta = None
        if target_message is not None:
            # The version being written, which is a new one for a regeneration.
            index = (target_message["active_index"] if continue_mode
                     else len(target_message["variants"]))
            marks = set(_cut_short(target_message))
            if failed:
                marks.add(index)
            elif continue_mode and final and body:
                marks.discard(index)
            target_meta = {k: v for k, v in target_message["meta"].items() if k != "interrupted"}
            if marks:
                target_meta["interrupted"] = sorted(marks)

        if continue_mode:
            variants = list(target_message["variants"])
            existing = target_message["variants"][target_message["active_index"]]
            # Nothing to add adds nothing: not the space that would have joined it.
            joiner = "" if (not body or not existing or existing[-1].isspace() or
                            body[0].isspace()) else " "
            variants[target_message["active_index"]] = existing + joiner + body
            saved = await convo_repo.update_message(
                db, target_message["id"], variants=variants, meta=target_meta)
            reply_gone = saved is None
            return saved

        if target_message is not None:
            variants = list(target_message["variants"]) + [body]
            saved = await convo_repo.update_message(
                db, target_message["id"], variants=variants, active_index=len(variants) - 1,
                meta=target_meta)
            reply_gone = saved is None
            return saved

        # A new reply. "streaming" marks it as still being written, so a client
        # arriving mid-turn can tell the difference between a short reply and one
        # that was cut off. The final write clears it; when that write never
        # comes, the next turn settles the mark (_settle_unfinished), unless the
        # turn knows it failed, and says so itself.
        # finish_reason kept for diagnosis: "length" means the reply was cut
        # mid-sentence by max_tokens, not by the model's choice.
        if final:
            meta = {"finish_reason": finish_reason} if finish_reason else {}
        elif failed:
            meta = {"interrupted": [0]}
        else:
            meta = {"streaming": True}
        if draft_id is None:
            if answering and not await convo_repo.get_message(db, answering["id"]):
                reply_gone = True
                return None
            created = await convo_repo.add_message(db, convo["id"], "assistant", [body], meta=meta)
            draft_id = created["id"]
            return created
        saved = await convo_repo.update_message(db, draft_id, variants=[body], meta=meta)
        reply_gone = saved is None
        return saved

    async def keep_what_arrived() -> None:
        """When the turn fails: whatever arrived is the reply as far as it goes. Never
        raises, since what it would hide is the reason the turn failed."""
        try:
            await persist(final=False, failed=True)
        except Exception:
            logger.exception("Could not keep what had arrived of a reply that failed")

    # At most two passes. A model whose chat template rejects a conversation
    # opening on the assistant's turn streams nothing at all rather than
    # erroring, and Evermind opens a conversation on the character's greeting
    # when it has one, so the first message of a first conversation dies
    # silently. Rather than hand that to someone as "try another model", fold
    # the greeting into the system prompt and ask once more.
    for attempt in (0, 1):
        # Closed on the way out of here, however that happens, and the request to the
        # model with it.
        try:
            async with aclosing(_until_stopped(_generate(connection, payload), stopped)) as events:
                async for event in events:
                    if event.type == "delta":
                        if first_token_at is None:
                            first_token_at = time.monotonic()
                        chunks.append(event.text)
                        yield _sse({"type": "delta", "text": event.text})
                        if time.monotonic() - flushed_at >= _FLUSH_SECONDS:
                            flushed_at = time.monotonic()
                            await persist(final=False)
                            if reply_gone:
                                yield _sse({"type": "discarded"})
                                return
                    elif event.type == "done":
                        usage = event.usage
                        finish_reason = (event.meta or {}).get("finish_reason")
                    elif event.type == "error":
                        # Refusing the greeting may be said in the stream rather than by silence.
                        if (event.meta.get("kind") == MODEL_ERROR and attempt == 0 and not chunks
                                and not continue_mode and payload.messages
                                and payload.messages[0]["role"] == "assistant"):
                            break
                        # Whatever arrived is the reply as far as it goes, as it is when
                        # the turn is stopped: flushing only now and then would lose up to
                        # the last second of what the person watched come.
                        await keep_what_arrived()
                        if reply_gone:
                            yield _sse({"type": "discarded"})
                            return
                        fields = failure_fields(event.meta)
                        yield error_event(event.message, fields.pop("kind"), **fields)
                        return
        except Exception:
            # Not the model failing as an event: something inside the provider raised,
            # such as a chunk that was not what the stream was promised to hold. What
            # arrived is kept all the same, and the failure goes on as it did.
            await keep_what_arrived()
            raise

        if stopped.is_set():
            # Stop the turn and keep what arrived, every word of it, which is what
            # stopping is. Flushing only now and then would lose up to the last second.
            await persist(final=False)
            if reply_gone:
                yield _sse({"type": "discarded"})
            return

        text = trim_reply("".join(chunks), char_name=char_name, user_name=user_name)
        # Only worth a second pass when nothing at all came back and the payload
        # has the shape that provokes it. A reply that arrived and then trimmed
        # to nothing is a different problem, and its deltas already reached the
        # client, so re-asking would duplicate text on screen.
        if (text or continue_mode or attempt == 1 or chunks
                or not payload.messages or payload.messages[0]["role"] != "assistant"):
            break
        retried_folded = True
        payload = _build(passages, fold_leading_assistant=True)

    if not text and not continue_mode:
        if retried_folded:
            yield error_event("The model returned nothing, twice, including once with the "
                              "opening line moved out of its way. Its chat template is "
                              "probably not usable for roleplay here; try another model.",
                              "model_empty_retried")
        else:
            yield error_event("The model returned an empty reply. Try again or switch models.",
                              MODEL_EMPTY)
        return

    saved = await persist(final=True)
    if reply_gone:
        yield _sse({"type": "discarded"})
        return

    await convo_repo.touch(db, convo["id"])

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
        "finish_reason": finish_reason,
    }
    done = {"type": "done", "message": saved, "context": payload.stats, "perf": perf}
    if continue_mode and not text:
        # The reply is as it was, which a person looking at it cannot tell from a
        # Continue that did nothing.
        done["nothing_added"] = True
    yield _sse(done)
    memory_service.schedule_if_due(convo["id"])


async def impersonate(db: aiosqlite.Connection, convo_id: str) -> dict:
    """Ghost-write the player's next message. Returns {"text": ...}."""
    try:
        convo, character, persona, connection, _ = await _resolve(db, convo_id)
    except _TurnError as exc:
        raise exc.as_app_error() from None

    char_name = character.get("name") or "Character"
    user_name = (persona or {}).get("name") or "User"
    messages = await convo_repo.list_messages(db, convo_id)
    if not messages:
        raise AppError("Nothing to write: the conversation is empty.", kind="conversation_empty")

    memories = await memories_repo.list_for_conversation(db, convo_id)
    payload = build_impersonate_payload(character, persona, convo, messages, connection, memories)
    chunks: list[str] = []
    async for event in get_provider(connection).stream_chat(payload):
        if event.type == "delta":
            chunks.append(event.text)
        elif event.type == "error":
            raise model_failure(event.message, event.meta)
    text = trim_reply("".join(chunks), char_name=user_name, user_name=char_name)
    if not text:
        raise AppError("The model did not suggest anything. Try again.", 502, kind=MODEL_EMPTY)
    return {"text": text}


async def summarize(db: aiosqlite.Connection, convo_id: str) -> dict:
    """The summary of the story so far, written by the model. The conversation as it stands,
    with "skipped" set and nothing written when another memory task was running ("busy"),
    or when the turns it read were not the story's any more when the model answered
    ("changed")."""
    try:
        convo, character, persona, connection, _ = await _resolve(db, convo_id)
    except _TurnError as exc:
        raise exc.as_app_error() from None

    async def busy() -> dict:
        return {**convo, "skipped": "busy"}

    return await memory_service.one_at_a_time(
        convo_id, lambda: _summarize(db, convo, character, persona, connection), busy)


async def _summarize(db: aiosqlite.Connection, convo: dict, character: dict, persona: dict | None,
                     connection: dict) -> dict:
    convo_id = convo["id"]
    messages = await convo_repo.list_messages(db, convo_id)
    if not messages:
        raise AppError("Nothing to summarize: the conversation is empty.", kind="conversation_empty")

    payload = build_summary_payload(character, persona, convo, messages, connection)

    chunks: list[str] = []
    async for event in get_provider(connection).stream_chat(payload):
        if event.type == "delta":
            chunks.append(event.text)
        elif event.type == "error":
            raise model_failure(event.message, event.meta)
    summary = "".join(chunks).strip()
    if not summary:
        raise AppError("The model returned an empty summary.", 502, kind=MODEL_EMPTY)
    # It describes the story up to the last message it was given, and the facts were not
    # read from those turns, so the memory is checkpointed with the position it had. The
    # story may have been cut back while the model answered, and it would then describe
    # turns that are gone.
    last = messages[-1]["position"]
    async with write_transaction(db):
        if await convo_repo.message_ids_through(db, convo_id, last) != [m["id"] for m in messages]:
            # It may have been deleted, in which case it is answered as it was read.
            current = await convo_repo.get(db, convo_id, with_messages=False)
            return {**(current or convo), "skipped": "changed"}
        await convo_repo.remember(db, convo_id, last, summary)
    return await convo_repo.get(db, convo_id, with_messages=False)
