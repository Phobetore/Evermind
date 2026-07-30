import aiosqlite
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ..db import get_db
from ..models.schemas import ChatRequest
from ..services import chat_service

router = APIRouter(prefix="/api", tags=["chat"])

_SSE_HEADERS = {
    # no-transform also tells compression middlewares to leave the stream alone
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


@router.post("/chat")
async def chat(request: ChatRequest, db: aiosqlite.Connection = Depends(get_db)):
    return StreamingResponse(
        chat_service.stream_turn(db, request),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post("/conversations/{convo_id}/summarize")
async def summarize(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    return await chat_service.summarize(db, convo_id)


@router.post("/conversations/{convo_id}/impersonate")
async def impersonate(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    return await chat_service.impersonate(db, convo_id)
