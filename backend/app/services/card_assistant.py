"""AI-assisted card creation: one brief in, a complete card draft out.

The draft is written on a job the server owns, so that a page that goes away, or a phone that
locks, loses nothing: the page asks how far it has got, and fetches the draft once it has ended.
A card the model did not finish still gives the fields it did. Nothing is persisted here: the
draft goes to the editor for the creator to adjust. Uses the requested connection, else the
default one.
"""

import asyncio
import logging
import time
import uuid
from contextlib import aclosing
from dataclasses import dataclass, field

import aiosqlite

from ..errors import (
    BRIEF_TOO_LONG,
    CARD_TOO_LONG,
    MODEL_EMPTY,
    MODEL_ONLY_THOUGHT,
    MODEL_UNREADABLE,
    NO_CONNECTION,
    AppError,
    NotFoundError,
    error_body,
)
from ..models.schemas import CardAssistRequest
from ..prompting.engine import PromptPayload
from ..prompting.payloads import (
    LIST_FIELDS,
    TEXT_FIELDS,
    build_card_payload,
    existing_fields,
    words,
)
from ..prompting.text import text_of
from ..prompting.tokens import estimate_tokens
from ..providers import get_provider
from ..providers.base import STOPPED_FOR_LENGTH, Provider
from ..repositories import connections as connections_repo
from .llm_json import describe_answer, parse_llm_json, partial_json

logger = logging.getLogger(__name__)

_MAX_LORE_ENTRIES = 8

# The fields of a card the model is asked for, in the order the prompt asks for them.
CARD_FIELDS = ("name", "tagline", "description", "personality", "scenario", "greeting",
               "alternate_greetings", "example_dialogues", "tags", "lore_entries")

# A whole card with a lorebook runs past 2048 tokens, and a card cut short loses its last fields.
_CEILING = 4096
# What the estimate of the prompt may miss: a ceiling past the context is refused by most servers.
_CONTEXT_MARGIN = 128
# The least room a card is written in: its fields at the lengths the prompt asks for, the lorebook
# aside. A brief that leaves less would come back as a name and little else.
_SMALLEST_CARD = 1024

_KEEP_SECONDS = 30 * 60
_KEEP_AT_MOST = 20


def _now() -> float:
    """The clock jobs are timed and forgotten by, which tests move instead of waiting."""
    return time.monotonic()


async def _resolve_connection(db: aiosqlite.Connection, connection_id: str | None) -> dict:
    connection = await connections_repo.resolve(db, connection_id)
    if connection is None:
        raise AppError(
            "No LLM connection configured. Add one in Settings → LLM connections.",
            kind=NO_CONNECTION)
    return connection


def _same(text: str) -> str:
    """What two spellings of one item share: case and the spaces around it do not make another."""
    return text.strip().lower()


def _once(items: list[str]) -> list[str]:
    """Each item the first time it comes, as it was first written."""
    first: dict[str, str] = {}
    for item in items:
        first.setdefault(_same(item), item)
    return list(first.values())


def _new_entries(entries: list[dict], existing: dict) -> list[dict]:
    """The entries that cover something the lorebook does not: one whose every key the book, or
    an entry before it, already has is the same subject written again, and would sit in it twice."""
    book = existing.get("lore_entries")
    known = {_same(key) for raw in (book if isinstance(book, list) else [])
             if isinstance(raw, dict) for key in words(raw.get("keys"))}
    fresh = []
    for entry in entries:
        keys = {_same(key) for key in entry["keys"]}
        if not keys <= known:
            fresh.append(entry)
            known |= keys
    return fresh


def clean_card_draft(draft: dict) -> dict:
    """Whitelist and normalize what the model returned."""
    out: dict = {}
    for field_name in TEXT_FIELDS:
        value = text_of(draft.get(field_name))
        if value:
            out[field_name] = value
    for field_name in LIST_FIELDS:
        items = words(draft.get(field_name))
        if field_name == "tags":
            items = [t.lower()[:40] for t in items]
        # A model repeats itself, and lowercasing makes "Fantasy" and "fantasy" one tag.
        items = _once(items)
        if field_name == "tags":
            items = items[:8]
        if items:
            out[field_name] = items

    entries = []
    lore = draft.get("lore_entries")
    for raw in (lore if isinstance(lore, list) else [])[:_MAX_LORE_ENTRIES]:
        if not isinstance(raw, dict):
            continue
        # A keyword written twice shows as two chips, and triggers the entry no more often.
        keys = _once(words(raw.get("keys")))
        content = text_of(raw.get("content"))
        if keys and content:
            entries.append({"keys": keys[:6], "content": content})
    if entries:
        out["lore_entries"] = entries
    return out


def _prompt_tokens(payload: PromptPayload) -> int:
    return estimate_tokens(payload.system) + sum(
        estimate_tokens(m.get("content") or "") for m in payload.messages)


def _check_fits(connection: dict, payload: PromptPayload, brief: str, existing: dict | None) -> None:
    """Refuses a brief the connection's context cannot hold along with the instructions and room
    for a card, before the model is asked: past it, a server refuses the request, or quietly drops
    the start of the brief and writes a card from what is left.

    The room counted is the least a card is written in, not the connection's own ceiling: people
    are told to raise that one, often close to the context, and chat still works with it, so it
    must not refuse every brief. When the card's own fields, sent along, outgrow the context
    whatever the brief, that is said instead: shortening the brief would not help."""
    context = connection.get("context_size") or 0
    needed = _prompt_tokens(payload) + _SMALLEST_CARD + _CONTEXT_MARGIN
    if not context or needed <= context:
        return
    the_card = existing_fields(existing) and needed - estimate_tokens(brief.strip()) > context
    # An estimate, told as one: to the hundred above, so that it never reads as fitting.
    about = -(-needed // 100) * 100
    raise AppError(
        f"The {'card' if the_card else 'brief'} is too long for this connection: about {about} "
        f"tokens with the instructions and the card, where its context holds {context}.",
        422, kind=CARD_TOO_LONG if the_card else BRIEF_TOO_LONG,
        params={"needed": about, "context": context})


def with_room_for_a_card(connection: dict, payload: PromptPayload) -> dict:
    """The connection with a ceiling on the answer that a whole card fits under.

    Only a ceiling the connection sets is raised: with none, the model's server decides, as for
    every other request. It never goes past what the context leaves once the prompt is in, nor
    under what the connection itself asks for."""
    own = connection.get("max_tokens")
    if not own:
        return connection
    room = (connection.get("context_size") or 0) - _prompt_tokens(payload) - _CONTEXT_MARGIN
    return dict(connection, max_tokens=max(own, min(_CEILING, room)))


@dataclass
class Job:
    id: str
    client_id: str | None
    existing: dict
    started: float
    parts: list[str] = field(default_factory=list)  # the answer as it arrived
    written: int = 0
    thought: int = 0
    stop_reason: str | None = None
    stopped: bool = False
    ended: float | None = None
    draft: dict | None = None
    missing: list[str] = field(default_factory=list)
    error: dict | None = None
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    reading: asyncio.Task | None = None  # the request to the model, which a stop cancels
    task: asyncio.Task | None = None
    # What the answer held the last time someone asked, and how long it was then: a page that asks
    # every second while nothing arrives costs no new reading of it.
    progress: tuple[int, dict] | None = None

    def text(self) -> str:
        if len(self.parts) > 1:
            self.parts[:] = ["".join(self.parts)]
        return self.parts[0] if self.parts else ""


_jobs: dict[str, Job] = {}


def _forget() -> None:
    """Jobs that ended half an hour ago, then the oldest ended ones past the most kept."""
    now = _now()
    for job_id, job in list(_jobs.items()):
        if job.ended is not None and now - job.ended >= _KEEP_SECONDS:
            del _jobs[job_id]
    ended = sorted((job for job in _jobs.values() if job.ended is not None),
                   key=lambda job: job.ended)
    for job in ended[:max(0, len(_jobs) - _KEEP_AT_MOST)]:
        del _jobs[job.id]


def _known(job_id: str) -> Job:
    _forget()
    job = _jobs.get(job_id)
    if job is None:
        raise NotFoundError("No card being written has this id.", "assist")
    return job


def _joined(client_id: str | None) -> Job | None:
    if not client_id:
        return None
    return next((job for job in _jobs.values() if job.client_id == client_id), None)


async def start(db: aiosqlite.Connection, request: CardAssistRequest) -> str:
    """Begin writing a card, or name the one this same request began; answers at once."""
    _forget()
    if job := _joined(request.client_id):
        return job.id
    connection = await _resolve_connection(db, request.connection_id)
    # Asked twice at once: the second has waited for the database while the first began.
    if job := _joined(request.client_id):
        return job.id
    payload = build_card_payload(request.prompt, request.kind, request.existing)
    _check_fits(connection, payload, request.prompt, request.existing)
    provider = get_provider(with_room_for_a_card(connection, payload))
    job = Job(uuid.uuid4().hex, request.client_id, dict(request.existing or {}), _now())
    _jobs[job.id] = job
    _forget()
    job.task = asyncio.create_task(_run(job, provider, payload))
    return job.id


async def _read(job: Job, provider: Provider, payload: PromptPayload) -> None:
    """Touches no database and keeps nothing of the model's reasoning but how long it was."""
    async with aclosing(provider.stream_chat(payload)) as stream:
        async for event in stream:
            if event.type == "delta":
                job.parts.append(event.text)
                job.written += len(event.text)
            elif event.type == "thought":
                job.thought += event.count
            elif event.type == "done":
                job.stop_reason = event.stop


async def _run(job: Job, provider: Provider, payload: PromptPayload) -> None:
    error: BaseException | None = None
    try:
        if not job.stopped:
            job.reading = asyncio.create_task(_read(job, provider, payload))
            # Waited for, not awaited: a stop cancels the reading, not this, which still ends the job.
            await asyncio.wait({job.reading})
            if not job.reading.cancelled():
                error = job.reading.exception()
    except asyncio.CancelledError:
        # The server is going down: an answer it no longer reads is not one the model got wrong.
        job.stopped = True
        raise
    finally:
        if job.reading:
            job.reading.cancel()  # a server going down would leave the request to the model open
        try:
            _end(job, error)
        except Exception:  # the job ends whatever happens, or whoever waits for it waits forever
            logger.exception("card assistant: a job could not end cleanly")
            job.error = {"error": "The card could not be finished.", "kind": "internal"}
        job.ended = _now()
        job.finished.set()


def _progress(job: Job) -> dict:
    """What the answer holds so far: read from the text when asked, not as each piece arrives."""
    if job.progress is None or job.progress[0] != job.written:
        parsed, writing = partial_json(job.text())
        cleaned = clean_card_draft(parsed)
        if "lore_entries" in cleaned:
            cleaned["lore_entries"] = _new_entries(cleaned["lore_entries"], job.existing)
            if not cleaned["lore_entries"]:
                del cleaned["lore_entries"]
        job.progress = (job.written, {
            "parsed": parsed,
            "cleaned": cleaned,
            "fields": [k for k in parsed if k in CARD_FIELDS and k in cleaned and k != writing],
            "lore": len(cleaned.get("lore_entries", [])),
            "writing": writing if writing in CARD_FIELDS else None,
        })
    return job.progress[1]


def _fail(job: Job, message: str, kind: str) -> None:
    job.error = {"error": message, "kind": kind}


def _end(job: Job, error: BaseException | None) -> None:
    text = job.text()
    progress = _progress(job)
    whole = parse_llm_json(text) is not None
    draft = progress["cleaned"]

    if error is not None:
        if isinstance(error, AppError):
            job.error = error_body(error)
        else:
            logger.error("card assistant: the job failed", exc_info=error)
            _fail(job, str(error) or type(error).__name__, "internal")
    elif job.stopped:
        pass  # what was complete is kept, and nothing went wrong
    elif not text and job.thought:
        _fail(job, "The model only thought, and wrote no card. Give it more room, or try again.",
              MODEL_ONLY_THOUGHT)
    elif not draft and not progress["parsed"]:
        logger.warning("card assistant: unreadable answer, %s", describe_answer(text))
        _fail(job, "The model did not return a readable card. Try again.", MODEL_UNREADABLE)
    elif not draft:
        # The names tell why: a model that translated the field names, or nested the card under one key.
        names = sorted(str(name)[:40] for name in progress["parsed"])[:12]
        logger.warning("card assistant: no card field in the answer, whose fields are %s; %s",
                       names, describe_answer(text))
        _fail(job, "The model returned an empty card. Try again.", MODEL_EMPTY)

    if job.error is not None:
        # No 502 carries it any more: this line is where a failure is seen in the log.
        upstream = getattr(error, "status", None)
        logger.warning("card assistant failed with %s: %s%s", job.error["kind"],
                       job.error["error"],
                       f" (the model's server answered {upstream})" if upstream else "")

    kept = existing_fields(job.existing)
    if draft:
        # never overwrite what the creator already wrote
        job.draft = {**draft, **kept}
    # A card whose lorebook has a keyed entry lacks none: asked again, the model would only write
    # the same subjects. An entry with no key is one added in the editor and never filled.
    book = job.existing.get("lore_entries")
    has_lore = isinstance(book, list) and any(
        isinstance(raw, dict) and words(raw.get("keys")) for raw in book)
    job.missing = [f for f in CARD_FIELDS if f not in (job.draft or {}) and f not in kept
                   and not (f == "lore_entries" and has_lore)]
    if not whole and job.draft is not None and not job.stopped and not job.error:
        logger.info("card assistant: a card was not finished (%s), missing %s; %s",
                    job.stop_reason, job.missing, describe_answer(text))


def _state_of(job: Job) -> dict:
    progress = _progress(job)
    ended = job.ended is not None
    return {
        "id": job.id,
        "running": not ended,
        "seconds": round((job.ended if ended else _now()) - job.started, 1),
        "thought": job.thought,
        "written": job.written,
        "fields": list(progress["fields"]),
        "lore": progress["lore"],
        "writing": progress["writing"],
        "draft": job.draft if ended else None,
        "missing": list(job.missing) if ended else [],
        "cut": ended and job.stop_reason == STOPPED_FOR_LENGTH,
        "stopped": job.stopped,
        "error": job.error if ended else None,
    }


def state(job_id: str) -> dict:
    return _state_of(_known(job_id))


async def stop(job_id: str) -> dict:
    """Cancels the request to the model and answers once the job has ended with what was complete.
    A job that had already ended stays as it was."""
    job = _known(job_id)
    if job.ended is None:
        if job.reading is None or not job.reading.done():
            job.stopped = True
            if job.reading:
                job.reading.cancel()
        await job.finished.wait()
    return _state_of(job)
