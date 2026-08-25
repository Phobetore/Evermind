import aiosqlite
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ..db import get_db
from ..models.schemas import ChatRequest
from ..services import chat_service, turns

router = APIRouter(prefix="/api", tags=["chat"])

_SSE_HEADERS = {
    # no-transform also tells compression middlewares to leave the stream alone
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


@router.post("/chat")
async def chat(request: ChatRequest):
    """Starts a turn, or attaches to the one already running for this
    conversation. No database dependency: the turn holds its own connection,
    because it outlives this request on purpose."""
    turn = await turns.start(request)
    return StreamingResponse(turns.follow(turn), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@router.get("/conversations/{convo_id}/turn")
async def turn_state(convo_id: str) -> dict:
    """Whether a reply is being written right now. A page opening asks this
    before deciding whether it is looking at a finished conversation or one
    still in progress somewhere else."""
    return {"running": turns.running_for(convo_id) is not None}


@router.get("/conversations/{convo_id}/turn/stream")
async def follow_turn(convo_id: str):
    """Attach to a turn already under way: the reply so far, then the rest as it
    arrives. Empty stream if nothing is running, rather than an error — a page
    that opens on a finished conversation is not a mistake."""
    turn = turns.running_for(convo_id)
    if not turn:
        return StreamingResponse(iter(()), media_type="text/event-stream",
                                 headers=_SSE_HEADERS)
    return StreamingResponse(turns.follow(turn), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@router.delete("/conversations/{convo_id}/turn", status_code=204)
async def stop_turn(convo_id: str) -> None:
    """Stopping has to be asked for now. It used to be implied by hanging up,
    which no longer means anything: a turn that survives a closed tab cannot
    tell that apart from someone changing their mind."""
    await turns.stop(convo_id)


@router.post("/conversations/{convo_id}/summarize")
async def summarize(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    return await chat_service.summarize(db, convo_id)


@router.post("/conversations/{convo_id}/impersonate")
async def impersonate(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    return await chat_service.impersonate(db, convo_id)
