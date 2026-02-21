"""CRUD endpoints for conversations."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.repositories.character_repository import CharacterRepository
from app.core.repositories.conversation_repository import ConversationRepository
from app.core.repositories.message_repository import MessageRepository
from app.models.conversation import ConversationCreate, ConversationResponse
from app.models.message import MessageCreate

router = APIRouter(prefix="/conversations", tags=["conversations"])


def _get_conv_repo() -> ConversationRepository:
    return ConversationRepository()


def _get_char_repo() -> CharacterRepository:
    return CharacterRepository()


def _get_msg_repo() -> MessageRepository:
    return MessageRepository()


@router.get("", response_model=list[ConversationResponse])
async def list_conversations(
    character_id: str | None = None,
    repo: ConversationRepository = Depends(_get_conv_repo),
) -> list[ConversationResponse]:
    if character_id:
        return await repo.list_by_character(character_id)
    return []


@router.post("", response_model=ConversationResponse, status_code=201)
async def create_conversation(
    data: ConversationCreate,
    conv_repo: ConversationRepository = Depends(_get_conv_repo),
    char_repo: CharacterRepository = Depends(_get_char_repo),
    msg_repo: MessageRepository = Depends(_get_msg_repo),
) -> ConversationResponse:
    # Verify the character exists
    character = await char_repo.get(data.character_id)
    if character is None:
        raise HTTPException(status_code=404, detail="Character not found")

    conversation = await conv_repo.create(data)

    # Auto-insert the character's first_message if it exists
    if character.first_message:
        await msg_repo.create(
            MessageCreate(
                conversation_id=conversation.id,
                role="assistant",
                content=character.first_message,
            )
        )

    return conversation


@router.get("/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(
    conversation_id: str,
    repo: ConversationRepository = Depends(_get_conv_repo),
) -> ConversationResponse:
    conversation = await repo.get(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@router.delete("/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: str,
    repo: ConversationRepository = Depends(_get_conv_repo),
) -> None:
    deleted = await repo.delete(conversation_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Conversation not found")
