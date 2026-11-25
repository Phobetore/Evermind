"""AIs: a model chosen on a service. Added with their service in one write, read again from their
server when asked, and removed without leaving a conversation on nothing."""

import asyncio
import time

import aiosqlite
from fastapi import APIRouter, Depends

from ..db import get_db
from ..errors import MODEL_UNREADABLE, AppError, NotFoundError
from ..models.schemas import ModelsCreate, ModelUpdate, ObservedIn, RefreshIn
from ..prompting.engine import PromptPayload
from ..prompting.tokens import estimate_tokens
from ..providers import catalog, get_provider
from ..providers.base import NO_TEXT, Answer, ProviderError, unwritten
from ..repositories import connections as services_repo
from ..repositories import models as repo
from ..repositories import settings as settings_repo
from ..repositories.connections import bare
from ..services import ai_call, limits
from .connections import held_service

router = APIRouter(prefix="/api/models", tags=["models"])

# What a local server is given to say the size it loads, list included, when an AI is added: an
# AI is never refused for it, and the next reply reads it again.
LOCAL_READ_S = 2
# The floor of the engine's budget: what a ceiling leaves the story at the least.
_ENGINE_FLOOR = 512


def _not_found() -> NotFoundError:
    return NotFoundError("AI not found.", "model")


def warnings(ai: dict) -> list[str]:
    """What the person typed that the server says is too much: kept, and said."""
    said = []
    context, cap = ai["context"], ai["reply_cap"]
    if context["own"] is not None and context["read"] is not None and context["own"] > context["read"]:
        said.append("above_read_window")
    if cap["mode"] == "fixed":
        if ai["output_read"] is not None and cap["tokens"] > ai["output_read"]:
            said.append("above_read_output")
        if cap["tokens"] + _ENGINE_FLOOR > context["used"]:
            said.append("cap_above_window")
    return said


@router.get("")
async def list_models(db: aiosqlite.Connection = Depends(get_db)):
    return await repo.list_all(db)


def _label(item: dict) -> str:
    read = item.get("read") if isinstance(item.get("read"), dict) else {}
    name = read.get("name")
    return name if isinstance(name, str) and name else item["model"].rsplit("/", 1)[-1] or \
        item["model"]


def _size_told(read: dict | None) -> bool:
    context = (read or {}).get("context")
    return isinstance(context, dict) and any(
        catalog.whole(context.get(kind)) for kind in ("served", "configured"))


async def _read_locally(service: dict, items: list[dict]) -> None:
    """A local server says the size it loads only at its own addresses (Ollama's /api/show), which
    the page's list does not carry: read here, under one delay for every AI added."""
    wanted = [item for item in items if not _size_told(item.get("read"))]
    if not wanted:
        return
    try:
        async with asyncio.timeout(LOCAL_READ_S):
            for item in wanted:
                listed, _ = await catalog.read_one(service, item["model"])
                if listed is not None:
                    item["read"] = {**repo.from_listed(listed), "name": _label(item)}
    except (TimeoutError, ProviderError):
        pass  # counted as a size untold, and read again after its first reply


@router.post("", status_code=201)
async def create_models(payload: ModelsCreate, db: aiosqlite.Connection = Depends(get_db)):
    ref = payload.service
    held = await held_service(db, ref)
    if payload.conversation_id and not await (await db.execute(
            "SELECT 1 FROM conversations WHERE id = ?", (payload.conversation_id,))).fetchone():
        raise NotFoundError("Conversation not found.", "conversation")
    saved = await services_repo.get_raw(db, ref.id) if ref.id else None
    service_id, changes, new = None, None, None
    if not ref.draft:
        service_id, changes = ref.id, {"family": ref.family}
    elif saved is not None and (saved["provider"], bare(saved["base_url"])) == (
            ref.provider, bare(ref.base_url)):
        # The saved service itself: a key typed replaces its own, as a revoked one is changed.
        service_id, changes = saved["id"], {"api_key": ref.api_key, "family": ref.family}
    elif same := await services_repo.find_same(db, held["provider"], held["base_url"],
                                               held["api_key"]):
        service_id, changes = same["id"], {"family": ref.family}
    else:
        family = ref.family or catalog.family_of(held["provider"], held["base_url"], "generic",
                                                 None)
        new = {"provider": held["provider"], "base_url": held["base_url"],
               "api_key": held["api_key"], "family": family,
               "name": ref.name or catalog.service_name(family, held["base_url"],
                                                        await services_repo.names(db))}

    service = new or await services_repo.get_raw(db, service_id)
    if service is None:
        raise NotFoundError("Service not found.", "connection")
    family = catalog.family_of(service["provider"], service["base_url"], service["family"],
                               service.get("family_url") or bare(service["base_url"]))
    if family == "generic" and ref.family:
        family = ref.family
    items = [{**item.model_dump(), "label": None} for item in payload.models]
    for item in items:
        item["label"] = _label(item)
    if family in catalog.LOCAL_FAMILIES:
        await _read_locally({**held, "family": family, "family_url": bare(held["base_url"])},
                            items)
    made = await repo.create_many(db, new or changes, service_id, items, payload.conversation_id)
    if not made:
        raise NotFoundError("Conversation not found.", "conversation")
    return made


@router.put("/{model_id}")
async def update_model(model_id: str, payload: ModelUpdate,
                       db: aiosqlite.Connection = Depends(get_db)):
    before = await repo.get_row(db, model_id)
    if before is None:
        raise _not_found()
    updated = await repo.update(db, model_id, payload.model_dump(exclude_unset=True))
    if updated is None:
        raise _not_found()
    if updated["model"] != before["model"]:
        limits.schedule_refresh(model_id, fresh=False)
    return {**updated, "warnings": warnings(updated)}


@router.delete("/{model_id}", status_code=204)
async def delete_model(model_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await repo.delete(db, model_id):
        raise _not_found()


@router.post("/{model_id}/refresh")
async def refresh_model(model_id: str, payload: RefreshIn | None = None,
                        db: aiosqlite.Connection = Depends(get_db)):
    """What the server says of the AI now. A read that fails keeps everything as it was."""
    model = await repo.get_row(db, model_id)
    if model is None:
        raise _not_found()
    service = await services_repo.get_raw(db, model["connection_id"])
    error = None
    try:
        listed, family = await catalog.read_one(service, model["model"],
                                                fresh=bool(payload and payload.fresh))
    except ProviderError as exc:
        error = {"kind": exc.kind, "message": exc.message}
    except Exception as exc:  # noqa: BLE001
        # Whatever else breaks a read, the page says so; what was read stays.
        error = {"kind": MODEL_UNREADABLE, "message": type(exc).__name__}
    else:
        # Asked for by the person, it may undo what a reply showed the server reads.
        await repo.store_read(db, model_id, model["model"], service, listed, family,
                              by_hand=bool(payload and payload.fresh))
    current = await repo.get(db, model_id)
    if current is None:
        raise _not_found()
    return {"model": current, "read_ok": error is None, "error": error}


@router.post("/{model_id}/observed")
async def observed_model(model_id: str, payload: ObservedIn,
                         db: aiosqlite.Connection = Depends(get_db)):
    """A reply seen read only from its end, at this size: counted from now on (the page then
    writes the reply again, shorter)."""
    ai = await repo.observe(db, model_id, payload.tokens)
    if ai is None:
        raise _not_found()
    return ai


@router.post("/{model_id}/benchmark")
async def benchmark_model(model_id: str, db: aiosqlite.Connection = Depends(get_db)):
    """Small real generation to measure first-token latency and tokens/s, saving nothing."""
    resolved = await repo.resolve(db, model_id)
    if resolved is None or resolved[0]["id"] != model_id:
        raise _not_found()
    model, service = resolved
    settings = await settings_repo.get_all(db)
    call = ai_call.call_for(model, service, room=ai_call.reply_room(None, settings))
    payload = PromptPayload(
        system="You are a speed test. Reply in plain prose.",
        messages=[{"role": "user", "content":
                   "Describe rain falling on a quiet street, in about 60 words."}],
        stop=[],
    )
    chunks: list[str] = []
    thought, stop = 0, None
    started = time.monotonic()
    first_token = None
    async for event in get_provider(call).stream_chat(payload):
        if event.type == "delta":
            if first_token is None:
                first_token = time.monotonic()
            chunks.append(event.text)
        elif event.type == "thought":
            thought += event.count
        else:
            stop = event.stop
    now = time.monotonic()
    if first_token is None:
        raise unwritten(Answer("", thought, stop)) or AppError(
            "No text generated.", 502, kind=NO_TEXT)
    tokens = estimate_tokens("".join(chunks))
    gen_time = max(0.05, now - first_token)
    return {
        "ok": True,
        "first_token_seconds": round(first_token - started, 2),
        "tokens_per_s": round(tokens / gen_time, 1),
        "tokens": tokens,
    }
