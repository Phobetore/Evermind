import json
from contextlib import aclosing

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
async def chat(request: ChatRequest) -> dict:
    """Answers once the message is saved; the turn has its own connection, as it outlives this."""
    turn = await turns.start(request)
    return {"user_message": turn.user_message}


@router.get("/conversations/{convo_id}/turn")
async def turn_state(convo_id: str) -> dict:
    """The message being written and all of it so far, or how the last turn ended if it failed."""
    turn = await turns.running_for(convo_id)
    if turn is None:
        return {"running": False, "outcome": turns.outcome_of(convo_id)}
    return {"running": True, "message_id": turn.message_id, "text": turn.text}


@router.get("/conversations/{convo_id}/turn/stream")
async def follow_turn(convo_id: str):
    """The message as far as it has got, then the rest as it arrives, then the end."""
    turn = await turns.running_for(convo_id)

    async def events():
        if turn:
            async with aclosing(turns.follow(turn)) as following:  # gone when its reader hangs up
                async for event in following:
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        yield 'data: {"end": true}\n\n'

    return StreamingResponse(events(), media_type="text/event-stream", headers=_SSE_HEADERS)


@router.delete("/conversations/{convo_id}/turn", status_code=204)
async def stop_turn(convo_id: str) -> None:
    """A reader going away is no stop: a turn outlives a phone going to sleep, so a stop is said."""
    await turns.stop(convo_id)


@router.post("/conversations/{convo_id}/impersonate")
async def impersonate(convo_id: str, db: aiosqlite.Connection = Depends(get_db)):
    return await chat_service.impersonate(db, convo_id)
