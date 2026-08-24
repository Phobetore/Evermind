import aiosqlite
from fastapi import APIRouter, Depends, UploadFile

from ..db import get_db
from ..errors import AppError, NotFoundError
from ..models.schemas import ConversationIn, ConversationPatch, MessagePatch
from ..prompting.macros import substitute
from ..repositories import characters as characters_repo
from ..repositories import connections as connections_repo
from ..repositories import conversations as repo
from ..repositories import personas as personas_repo
from ..repositories import settings as settings_repo
from ..services import media

router = APIRouter(prefix="/api", tags=["conversations"])


@router.get("/conversations")
async def list_conversations(character_id: str | None = None,
                             db: aiosqlite.Connection = Depends(get_db)):
    return await repo.list_all(db, character_id=character_id)


@router.post("/conversations", status_code=201)
async def create_conversation(payload: ConversationIn,
                              db: aiosqlite.Connection = Depends(get_db)):
    character = await characters_repo.get_raw(db, payload.character_id)
    if not character:
        raise NotFoundError("Character not found.")

    fields = payload.model_dump()
    settings = await settings_repo.get_all(db)
    if not fields.get("persona_id"):
        fields["persona_id"] = settings.get("default_persona_id")
    if not fields.get("connection_id"):
        fields["connection_id"] = settings.get("default_connection_id")

    # Either id may point at a row that no longer exists (stale settings, stale
    # UI listing). Drop it rather than let the insert fail on the foreign key.
    if fields.get("persona_id") and not await personas_repo.get(db, fields["persona_id"]):
        fields["persona_id"] = None
    if fields.get("connection_id") and not await connections_repo.get(db, fields["connection_id"]):
        fields["connection_id"] = None

    convo = await repo.create(db, fields)

    greetings = [g for g in [character.get("greeting"), *character.get("alternate_greetings", [])]
                 if g and g.strip()]
    if greetings:
        persona = await personas_repo.get(db, fields["persona_id"]) if fields.get("persona_id") else None
        user_name = (persona or {}).get("name") or "User"
        variants = [substitute(g, char_name=character["name"], user_name=user_name)
                    for g in greetings]
        index = payload.greeting_index if 0 <= payload.greeting_index < len(variants) else 0
        await repo.add_message(db, convo["id"], "assistant", variants, active_index=index,
                               meta={"greeting": True})
    return await repo.get(db, convo["id"])


@router.get("/conversations/{convo_id}")
async def get_conversation(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    convo = await repo.get(db, convo_id)
    if not convo:
        raise NotFoundError("Conversation not found.")
    return convo


@router.patch("/conversations/{convo_id}")
async def patch_conversation(convo_id: str, payload: ConversationPatch,
                             db: aiosqlite.Connection = Depends(get_db)):
    updated = await repo.update(db, convo_id, payload.model_dump(exclude_unset=True))
    if not updated:
        raise NotFoundError("Conversation not found.")
    return updated


@router.post("/conversations/{convo_id}/wallpaper")
async def upload_wallpaper(convo_id: str, file: UploadFile,
                           db: aiosqlite.Connection = Depends(get_db)):
    previous = (await repo.get(db, convo_id, with_messages=False) or {}).get("wallpaper_url") or ""
    data, extension = await media.read_image_upload(file)
    updated = await repo.update(db, convo_id, {"wallpaper_path": media.save(data, extension)})
    if not updated:
        raise NotFoundError("Conversation not found.")
    # Only if nothing else still points at it: branching shares the one file.
    await media.forget(db, previous.removeprefix("/api/media/"))
    return updated


@router.delete("/conversations/{convo_id}/wallpaper")
async def clear_wallpaper(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    """Empty string rather than null: the column has no nulls, and the update
    below skips a None as "leave this alone"."""
    previous = (await repo.get(db, convo_id, with_messages=False) or {}).get("wallpaper_url") or ""
    updated = await repo.update(db, convo_id, {"wallpaper_path": ""})
    if not updated:
        raise NotFoundError("Conversation not found.")
    await media.forget(db, previous.removeprefix("/api/media/"))
    return updated


@router.delete("/conversations/{convo_id}", status_code=204)
async def delete_conversation(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await repo.delete(db, convo_id):
        raise NotFoundError("Conversation not found.")


@router.patch("/messages/{message_id}")
async def patch_message(message_id: str, payload: MessagePatch,
                        db: aiosqlite.Connection = Depends(get_db)):
    message = await repo.get_message(db, message_id)
    if not message:
        raise NotFoundError("Message not found.")
    variants = None
    active_index = None
    if payload.content is not None:
        variants = list(message["variants"])
        variants[message["active_index"]] = payload.content
    if payload.active_index is not None:
        if payload.active_index >= len(message["variants"]):
            raise AppError("Variant index out of range.")
        active_index = payload.active_index
    return await repo.update_message(db, message_id, variants=variants, active_index=active_index)


@router.post("/messages/{message_id}/branch", status_code=201)
async def branch_conversation(message_id: str, db: aiosqlite.Connection = Depends(get_db)):
    branch = await repo.branch_from_message(db, message_id)
    if not branch:
        raise NotFoundError("Message not found.")
    return branch


@router.delete("/messages/{message_id}", status_code=204)
async def delete_message(message_id: str, following: bool = False,
                         db: aiosqlite.Connection = Depends(get_db)):
    if not await repo.delete_message(db, message_id, following=following):
        raise NotFoundError("Message not found.")
