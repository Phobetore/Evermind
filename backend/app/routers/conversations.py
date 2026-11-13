import asyncio
from collections.abc import Awaitable, Callable

import aiosqlite
from fastapi import APIRouter, Depends, UploadFile

from ..db import get_db
from ..errors import AppError, NotFoundError
from ..models.schemas import BranchIn, ConversationIn, ConversationPatch, MessagePatch
from ..prompting.engine import speaking_name
from ..prompting.macros import substitute
from ..repositories import characters as characters_repo
from ..repositories import connections as connections_repo
from ..repositories import conversations as repo
from ..repositories import personas as personas_repo
from ..services import media, memory_service, turns

router = APIRouter(prefix="/api", tags=["conversations"])

# A start or a branch asked for again under its id is the one made, while the server runs.
_made: dict[str, str] = {}
_making: dict[str, asyncio.Event] = {}


async def _once(db: aiosqlite.Connection, client_id: str | None,
                make: Callable[[], Awaitable[dict | None]]) -> dict | None:
    if client_id is None:
        return await make()
    while client_id in _making:
        await _making[client_id].wait()
    if client_id in _made and (made := await repo.get(db, _made[client_id])):
        return made
    _making[client_id] = asyncio.Event()
    try:
        made = await make()
        if made:
            _made[client_id] = made["id"]
            while len(_made) > 100:
                del _made[next(iter(_made))]
        return made
    finally:
        _making.pop(client_id).set()


@router.get("/conversations")
async def list_conversations(character_id: str | None = None,
                             db: aiosqlite.Connection = Depends(get_db)):
    return await repo.list_all(db, character_id=character_id)


@router.post("/conversations", status_code=201)
async def create_conversation(payload: ConversationIn,
                              db: aiosqlite.Connection = Depends(get_db)):
    return await _once(db, payload.client_id, lambda: _create_conversation(db, payload))


async def _create_conversation(db: aiosqlite.Connection, payload: ConversationIn) -> dict | None:
    character = await characters_repo.get(db, payload.character_id)
    if not character:
        raise NotFoundError("Character not found.", "character")

    fields = payload.model_dump()
    # A persona or a connection gone since the page listed it counts as none asked for, rather
    # than failing the insert on its foreign key.
    persona = await personas_repo.for_conversation(db, fields)
    fields["persona_id"] = persona["id"] if persona else None

    if fields.get("connection_id") and not await connections_repo.get(db, fields["connection_id"]):
        fields["connection_id"] = None

    convo = await repo.create(db, fields)

    greetings = [g for g in [character.get("greeting"), *character.get("alternate_greetings", [])]
                 if g and g.strip()]
    if greetings:
        user_name = (persona or {}).get("name") or "User"
        variants = [substitute(g, char_name=speaking_name(character), user_name=user_name)
                    for g in greetings]
        await repo.add_message(db, convo["id"], "assistant", variants, meta={"greeting": True})
    return await repo.get(db, convo["id"])


@router.get("/conversations/{convo_id}")
async def get_conversation(convo_id: str, messages: bool = True,
                           db: aiosqlite.Connection = Depends(get_db)):
    # One snapshot: the revision it carries is that of the messages it holds.
    await db.execute("BEGIN")
    convo = await repo.get(db, convo_id, with_messages=messages)
    await db.commit()
    if not convo:
        raise NotFoundError("Conversation not found.", "conversation")
    return {**convo, "memory_error": memory_service.failure_of(convo_id),
            "memory_running": memory_service.is_running(convo_id)}


@router.patch("/conversations/{convo_id}")
async def patch_conversation(convo_id: str, payload: ConversationPatch,
                             db: aiosqlite.Connection = Depends(get_db)):
    updated = await repo.update(db, convo_id, payload.model_dump(exclude_unset=True))
    if not updated:
        raise NotFoundError("Conversation not found.", "conversation")
    return updated


@router.post("/conversations/{convo_id}/wallpaper")
async def upload_wallpaper(convo_id: str, file: UploadFile,
                           db: aiosqlite.Connection = Depends(get_db)):
    data, extension = await media.read_image_upload(file)
    if not await repo.get(db, convo_id, with_messages=False):
        raise NotFoundError("Conversation not found.", "conversation")
    return await repo.update(db, convo_id, {"wallpaper_path": media.save(data, extension)})


@router.delete("/conversations/{convo_id}/wallpaper")
async def clear_wallpaper(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    """Empty string rather than null: the column has no nulls, and the update
    below skips a None as "leave this alone"."""
    updated = await repo.update(db, convo_id, {"wallpaper_path": ""})
    if not updated:
        raise NotFoundError("Conversation not found.", "conversation")
    return updated


@router.delete("/conversations/{convo_id}", status_code=204)
async def delete_conversation(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    await turns.stop(convo_id)
    if not await repo.delete(db, convo_id):
        raise NotFoundError("Conversation not found.", "conversation")


@router.patch("/messages/{message_id}")
async def patch_message(message_id: str, payload: MessagePatch,
                        db: aiosqlite.Connection = Depends(get_db)):
    message = await repo.get_message(db, message_id)
    if not message:
        raise NotFoundError("Message not found.", "message")
    # The version shown, and the one an edit names: the page's, which a lost swipe can leave behind.
    index = message["active_index"] if payload.active_index is None else payload.active_index
    if index >= len(message["variants"]):
        raise AppError("Variant index out of range.", kind="variant_out_of_range")
    variants = None
    if payload.content is not None:
        variants = list(message["variants"])
        variants[index] = payload.content
    # A swipe shows other words; not an edit, where a typo put right would undo every pass since.
    return await repo.update_message(db, message_id, variants=variants,
                                     active_index=payload.active_index,
                                     reread=index != message["active_index"])


@router.post("/messages/{message_id}/branch", status_code=201)
async def branch_conversation(message_id: str, payload: BranchIn | None = None,
                              db: aiosqlite.Connection = Depends(get_db)):
    branch = await _once(db, payload and payload.client_id,
                         lambda: repo.branch_from_message(db, message_id))
    if not branch:
        raise NotFoundError("Message not found.", "message")
    return branch


@router.delete("/messages/{message_id}", status_code=204)
async def delete_message(message_id: str, db: aiosqlite.Connection = Depends(get_db)):
    message = await repo.get_message(db, message_id)
    # What the reply being written has, it writes before the story is cut, and nothing after.
    if message:
        await turns.stop(message["conversation_id"])
    if not message or not await repo.delete_message(db, message_id):
        raise NotFoundError("Message not found.", "message")
