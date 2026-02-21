"""Endpoints for conversation messages."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.repositories.message_repository import MessageRepository
from app.models.message import MessageCreate, MessageResponse

router = APIRouter(prefix="/conversations/{conversation_id}/messages", tags=["messages"])


def _get_repo() -> MessageRepository:
    return MessageRepository()


@router.get("", response_model=list[MessageResponse])
async def list_messages(
    conversation_id: str,
    limit: int = 50,
    offset: int = 0,
    repo: MessageRepository = Depends(_get_repo),
) -> list[MessageResponse]:
    return await repo.list_by_conversation(conversation_id, limit=limit, offset=offset)


@router.post("", response_model=MessageResponse, status_code=201)
async def create_message(
    conversation_id: str,
    data: MessageCreate,
    repo: MessageRepository = Depends(_get_repo),
) -> MessageResponse:
    if data.conversation_id != conversation_id:
        raise HTTPException(status_code=400, detail="conversation_id mismatch")
    return await repo.create(data)
