"""CRUD endpoints for conversations."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.repositories.conversation_repository import ConversationRepository
from app.models.conversation import ConversationCreate, ConversationResponse

router = APIRouter(prefix="/conversations", tags=["conversations"])


def _get_repo() -> ConversationRepository:
    return ConversationRepository()


@router.get("", response_model=list[ConversationResponse])
async def list_conversations(
    character_id: str | None = None,
    repo: ConversationRepository = Depends(_get_repo),
) -> list[ConversationResponse]:
    if character_id:
        return await repo.list_by_character(character_id)
    # If no filter provided, return empty — frontend should always filter by character
    return []


@router.post("", response_model=ConversationResponse, status_code=201)
async def create_conversation(
    data: ConversationCreate,
    repo: ConversationRepository = Depends(_get_repo),
) -> ConversationResponse:
    return await repo.create(data)


@router.get("/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(
    conversation_id: str,
    repo: ConversationRepository = Depends(_get_repo),
) -> ConversationResponse:
    conversation = await repo.get(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@router.delete("/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: str,
    repo: ConversationRepository = Depends(_get_repo),
) -> None:
    deleted = await repo.delete(conversation_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Conversation not found")
