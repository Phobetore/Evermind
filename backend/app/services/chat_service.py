"""One chat turn, streamed end to end.

SSE wire contract (one `data: <json>` line per event):
  {"type":"start","conversation_id":...,"user_message":{...}|null,"target_message_id":...|null}
  {"type":"delta","text":"..."}
  {"type":"done","message":{...MessageOut},"context":{...},"perf":{...}}
  {"type":"error","message":"...","kind":"...","resource":"..."}
  (``kind`` names the failure for the interface; ``resource`` only goes with
  "not_found", and says what was not found. A model's failure also carries
  what its server said: ``upstream``, ``upstream_status``, ``upstream_url``.)

Modes:
  send        — persist the user message, generate the reply.
  regenerate  — last message assistant: add a new variant (history excludes it);
                last message user (after an error): generate the missing reply.
  continue    — extend the active variant of the last assistant message.
"""

import json
import re
import time
from collections.abc import AsyncIterator

import aiosqlite

from ..errors import (
    MODEL_EMPTY,
    NO_CONNECTION,
    NOT_FOUND,
    AppError,
    NotFoundError,
    failure_fields,
    model_failure,
)
from ..models.schemas import ChatRequest
from ..prompting import embeddings, retrieval
from ..prompting.defaults import IMPERSONATE_PROMPT, SUMMARIZE_PROMPT
from ..prompting.engine import PromptPayload, active_content, build_chat_payload
from ..prompting.macros import substitute
from ..prompting.tokens import estimate_tokens
from ..providers import get_provider
from ..repositories import characters as characters_repo
from ..repositories import connections as connections_repo
from ..repositories import conversations as convo_repo
from ..repositories import lore as lore_repo
from ..repositories import memories as memories_repo
from ..repositories import personas as personas_repo
from ..repositories import settings as settings_repo
from . import memory_service

# How often a reply in progress is written to the database. Often enough that
# closing a tab loses at most a second of text, rarely enough that a long reply
# costs a handful of writes rather than one per token.
_FLUSH_SECONDS = 1.0

_CONTINUE_INSTRUCTION = (
    "[Continue your previous reply exactly where it stopped. Do not repeat anything, "
    "do not start over — just keep going seamlessly.]"
)


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


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
    persona = await personas_repo.get(db, convo["persona_id"]) if convo.get("persona_id") else None
    if persona is None:
        persona = await personas_repo.get_default(db)
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


def _trim_reply(text: str, char_name: str, user_name: str) -> str:
    """Post-generation cleanup: drop anything the model wrote for the player,
    and a leading "Name:" speaker tag if present."""
    for marker in (f"\n{user_name}:", f"\n{user_name} :"):
        index = text.find(marker)
        if index != -1:
            text = text[:index]
    stripped = text.lstrip()
    for prefix in (f"{char_name}:", f"{char_name} :"):
        if stripped.startswith(prefix):
            text = stripped[len(prefix):].lstrip()
            break
    return text.rstrip()


async def _generate(connection: dict, payload: PromptPayload):
    provider = get_provider(connection)
    async for event in provider.stream_chat(payload):
        yield event


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
        meta["interrupted"] = True
        settled.append(await convo_repo.update_message(db, message["id"], meta=meta) or message)
    return settled


async def stream_turn(db: aiosqlite.Connection, request: ChatRequest) -> AsyncIterator[str]:
    try:
        convo, character, persona, connection, settings = await _resolve(db, request.conversation_id)
    except _TurnError as exc:
        yield error_event(exc.message, exc.kind, exc.resource)
        return

    char_name = character.get("name") or "Character"
    user_name = (persona or {}).get("name") or "User"
    messages = await _settle_unfinished(db, await convo_repo.list_messages(db, convo["id"]))

    user_message = None
    target_message = None  # existing assistant message receiving a new/extended variant
    continue_mode = False

    if request.mode == "send":
        content = (request.content or "").strip()
        if not content:
            yield error_event("Empty message.", "empty_message")
            return
        message_meta = {}
        if request.message_mode in ("narrate", "ooc"):
            message_meta["mode"] = request.message_mode
        user_message = await convo_repo.add_message(db, convo["id"], "user", [content],
                                                    meta=message_meta)
        if not (convo.get("title") or "").strip() and request.message_mode == "say":
            await convo_repo.update(db, convo["id"], {"title": _auto_title(content)})
        messages = messages + [user_message]
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
            history = messages
    elif request.mode == "continue":
        if not messages or messages[-1]["role"] != "assistant":
            yield error_event("Nothing to continue: the last message is not a reply.",
                              "nothing_to_continue")
            return
        target_message = messages[-1]
        continue_mode = True
        history = messages + [{
            "role": "user", "variants": [_CONTINUE_INSTRUCTION], "active_index": 0,
            "position": messages[-1]["position"] + 1,
        }]
    else:  # the request schema lets only the three modes above through
        yield error_event(f"Unknown mode: {request.mode}", "internal")
        return

    memories = await memories_repo.list_for_conversation(db, convo["id"])
    lore_entries = await lore_repo.list_for_character(db, character["id"])

    # Semantic recall: rank out-of-window facts by relevance to the live scene
    # (the last couple of turns). Falls back to recency when embeddings are off.
    scene = "\n".join(active_content(m) for m in history[-2:]) if history else ""
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
        oldest_visible = payload.stats.get("oldest_visible") or 0
        fact_positions = {p for p in (payload.stats.get("fact_positions") or []) if p is not None}
        candidates = [m for m in history if (m.get("position") or 0) < oldest_visible]
        if candidates:
            msg_emb = await convo_repo.list_message_embeddings(db, convo["id"])
            for m in candidates:  # lazy-fill vectors for newly out-of-window messages
                if m["id"] not in msg_emb:
                    vecs = await embeddings.embed([active_content(m)], kind="passage")
                    if vecs:
                        blob = embeddings.pack(vecs[0])
                        await convo_repo.set_message_embedding(db, m["id"], blob)
                        msg_emb[m["id"]] = blob
            cand_map = {m["id"]: msg_emb[m["id"]] for m in candidates if m["id"] in msg_emb}
            scores = await retrieval.rank(scene, cand_map)
            if scores:
                infos = [{"id": m["id"], "content": active_content(m),
                          "position": m.get("position") or 0, "role": m["role"]}
                         for m in candidates if m["id"] in cand_map]
                passages = retrieval.select_passages(scores, infos, passage_budget,
                                                     exclude_positions=fact_positions)
                if passages:
                    payload = _build(passages)  # pass 2 — inject RELEVANT PAST

    # target_message_id says which reply this turn is replacing or extending, so
    # that a page arriving in the middle of one knows not to show that reply and
    # its replacement at the same time.
    yield _sse({"type": "start", "conversation_id": convo["id"],
                "user_message": user_message,
                "target_message_id": target_message["id"] if target_message else None})

    chunks: list[str] = []
    usage = None
    finish_reason = None
    first_token_at = None
    started_at = time.monotonic()
    retried_folded = False

    # The reply is written to the database while it streams, not only once it is
    # finished. A turn that is stopped leaves this generator at a yield, and a
    # server that goes down leaves it anywhere: flushing as it goes means
    # whatever has arrived is already kept, without depending on cleanup at all.
    draft_id: str | None = None
    flushed_at = 0.0

    async def persist(*, final: bool) -> dict | None:
        """Write what has streamed so far. Recomputed from the original variants
        every time, so calling it repeatedly is the same as calling it once."""
        nonlocal draft_id
        body = _trim_reply("".join(chunks), char_name=char_name, user_name=user_name)
        if not body and not final:
            return None

        if continue_mode:
            variants = list(target_message["variants"])
            existing = target_message["variants"][target_message["active_index"]]
            joiner = "" if (not existing or existing[-1].isspace() or
                            (body and body[0].isspace())) else " "
            variants[target_message["active_index"]] = existing + joiner + body
            return await convo_repo.update_message(db, target_message["id"], variants=variants)

        if target_message is not None:
            variants = list(target_message["variants"]) + [body]
            return await convo_repo.update_message(
                db, target_message["id"], variants=variants, active_index=len(variants) - 1)

        # A new reply. "streaming" marks it as still being written, so a client
        # arriving mid-turn can tell the difference between a short reply and one
        # that was cut off. The final write clears it; when that write never
        # comes, the next turn settles the mark (_settle_unfinished).
        # finish_reason kept for diagnosis: "length" means the reply was cut
        # mid-sentence by max_tokens, not by the model's choice.
        if final:
            meta = {"finish_reason": finish_reason} if finish_reason else {}
        else:
            meta = {"streaming": True}
        if draft_id is None:
            created = await convo_repo.add_message(db, convo["id"], "assistant", [body], meta=meta)
            draft_id = created["id"]
            return created
        return await convo_repo.update_message(db, draft_id, variants=[body], meta=meta)

    # At most two passes. A model whose chat template rejects a conversation
    # opening on the assistant's turn streams nothing at all rather than
    # erroring, and Evermind opens a conversation on the character's greeting
    # when it has one, so the first message of a first conversation dies
    # silently. Rather than hand that to someone as "try another model", fold
    # the greeting into the system prompt and ask once more.
    for attempt in (0, 1):
        # No cleanup handler here, on purpose: a stopped turn leaves this
        # generator while turns._run closes the database connection it was
        # given, so there is nothing reliable left to save with. persist() has
        # already written what arrived, up to its last flush.
        async for event in _generate(connection, payload):
            if event.type == "delta":
                if first_token_at is None:
                    first_token_at = time.monotonic()
                chunks.append(event.text)
                yield _sse({"type": "delta", "text": event.text})
                if time.monotonic() - flushed_at >= _FLUSH_SECONDS:
                    flushed_at = time.monotonic()
                    await persist(final=False)
            elif event.type == "done":
                usage = event.usage
                finish_reason = (event.meta or {}).get("finish_reason")
            elif event.type == "error":
                fields = failure_fields(event.meta)
                yield error_event(event.message, fields.pop("kind"), **fields)
                return

        text = _trim_reply("".join(chunks), char_name=char_name, user_name=user_name)
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
    yield _sse({"type": "done", "message": saved, "context": payload.stats, "perf": perf})
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
    base = build_chat_payload(character=character, persona=persona, conversation=convo,
                              messages=messages, connection=connection, memories=memories)

    context_bits = []
    if (persona or {}).get("description"):
        context_bits.append(f"ABOUT {user_name}: {persona['description']}")
    if convo.get("summary"):
        context_bits.append(f"STORY SO FAR: {convo['summary']}")
    system = substitute(IMPERSONATE_PROMPT, char_name=char_name, user_name=user_name)
    if context_bits:
        system += "\n\n" + "\n\n".join(context_bits)

    # Flip roles: the character's turns become "user", the player's become
    # "assistant", so the model naturally continues as the player.
    flipped = [{"role": "user" if m["role"] == "assistant" else "assistant",
                "content": m["content"]} for m in base.messages]

    payload = PromptPayload(system=system, messages=flipped, stop=[f"\n{char_name}:"])
    chunks: list[str] = []
    async for event in get_provider(connection).stream_chat(payload):
        if event.type == "delta":
            chunks.append(event.text)
        elif event.type == "error":
            raise model_failure(event.message, event.meta)
    text = _trim_reply("".join(chunks), char_name=user_name, user_name=char_name)
    if not text:
        raise AppError("The model did not suggest anything. Try again.", 502, kind=MODEL_EMPTY)
    return {"text": text}


async def summarize(db: aiosqlite.Connection, convo_id: str) -> dict:
    try:
        convo, character, persona, connection, _ = await _resolve(db, convo_id)
    except _TurnError as exc:
        raise exc.as_app_error() from None

    char_name = character.get("name") or "Character"
    user_name = (persona or {}).get("name") or "User"
    messages = await convo_repo.list_messages(db, convo_id)
    if not messages:
        raise AppError("Nothing to summarize: the conversation is empty.", kind="conversation_empty")

    base = build_chat_payload(character=character, persona=persona, conversation=convo,
                              messages=messages, connection=connection)
    payload = PromptPayload(
        system=substitute(SUMMARIZE_PROMPT, char_name=char_name, user_name=user_name),
        messages=[*base.messages,
                  {"role": "user", "content": "[Write the summary of the roleplay so far now.]"}],
        stop=[],
    )

    chunks: list[str] = []
    async for event in get_provider(connection).stream_chat(payload):
        if event.type == "delta":
            chunks.append(event.text)
        elif event.type == "error":
            raise model_failure(event.message, event.meta)
    summary = "".join(chunks).strip()
    if not summary:
        raise AppError("The model returned an empty summary.", 502, kind=MODEL_EMPTY)
    await convo_repo.update(db, convo_id, {"summary": summary})
    return await convo_repo.get(db, convo_id, with_messages=False)
