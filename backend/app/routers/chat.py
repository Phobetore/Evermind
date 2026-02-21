"""Chat streaming endpoint — POST /chat/stream (SSE)."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.models.chat import ChatStreamRequest  # noqa: TCH001
from app.services.chat_service import ChatService

router = APIRouter(tags=["chat"])


@router.post("/chat/stream")
async def chat_stream(request: ChatStreamRequest) -> StreamingResponse:
    """Stream chat tokens via Server-Sent Events."""
    service = ChatService()
    return StreamingResponse(
        service.stream_chat(
            conversation_id=request.conversation_id,
            character_id=request.character_id,
            user_message=request.user_message,
            profile_id=request.profile_id,
            generation_params=request.generation_params,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
