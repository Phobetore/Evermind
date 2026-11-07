"""A reply belongs to the server: written on a task of its own and saved every second."""

import asyncio
import logging
from dataclasses import dataclass, field

from ..db import _connect
from ..errors import TURN_RUNNING, AppError
from ..models.schemas import ChatRequest
from . import chat_service

logger = logging.getLogger(__name__)


@dataclass
class Turn:
    conversation_id: str
    mode: str
    client_id: str | None
    text: str = ""  # the whole of the message being written, as far as it has got
    message_id: str | None = None  # the message being written, known before it exists
    user_message: dict | None = None
    refused: AppError | None = None  # why nothing was saved
    accepted: asyncio.Event = field(default_factory=asyncio.Event)
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    stopped: bool = False
    reading: asyncio.Task | None = None  # the request to the model, which a stop cancels
    task: asyncio.Task | None = None
    readers: set[asyncio.Queue] = field(default_factory=set)

    def add(self, text: str) -> None:
        self.text += text
        for reader in self.readers:
            reader.put_nowait(text)

    def stop(self) -> None:
        self.stopped = True
        if self.reading:
            self.reading.cancel()


_running: dict[str, Turn] = {}
# How the last turn of a conversation ended, when it failed or added nothing, until the next one.
_outcomes: dict[str, dict] = {}


async def running_for(conversation_id: str) -> Turn | None:
    """The turn being written, once its message is saved."""
    turn = _running.get(conversation_id)
    if turn:
        await turn.accepted.wait()
    return None if turn is None or turn.finished.is_set() else turn


def outcome_of(conversation_id: str) -> dict | None:
    return _outcomes.get(conversation_id)


async def _run(turn: Turn, request: ChatRequest) -> None:
    db = None
    try:
        db = await _connect()
        outcome = await chat_service.run_turn(db, request, turn)
        if outcome:
            _outcomes[turn.conversation_id] = {**outcome, "mode": turn.mode}
    except Exception as exc:  # whatever it was, whoever asked is told
        if not isinstance(exc, AppError):
            logger.exception("A turn failed")
        if not turn.accepted.is_set():
            turn.refused = exc if isinstance(exc, AppError) else AppError(
                str(exc), 500, kind="internal")
        else:
            _outcomes[turn.conversation_id] = {
                "kind": "internal", "message": str(exc), "mode": turn.mode}
    finally:
        if turn.reading:
            turn.reading.cancel()  # a server going down would leave the request to the model open
        # Gone before anyone can learn it ended: nobody who saw the end is told it is still written.
        if _running.get(turn.conversation_id) is turn:
            del _running[turn.conversation_id]
        turn.accepted.set()
        turn.finished.set()
        for reader in turn.readers:
            reader.put_nowait(None)
        if db is not None:
            await db.close()


async def start(request: ChatRequest) -> Turn:
    """Begin a turn, or join the same one, once its message is saved; anything else is refused."""
    turn = _running.get(request.conversation_id)
    if turn is None:
        _outcomes.pop(request.conversation_id, None)
        turn = Turn(request.conversation_id, request.mode, request.client_id)
        _running[request.conversation_id] = turn
        turn.task = asyncio.create_task(_run(turn, request))
    elif (request.mode, request.client_id) != (turn.mode, turn.client_id) or (
            request.mode == "send" and not request.client_id):
        raise AppError("A reply is still being written.", 409, kind=TURN_RUNNING)
    await turn.accepted.wait()
    if turn.refused:
        raise turn.refused
    return turn


async def stop(conversation_id: str) -> None:
    """Answers once what arrived is saved."""
    turn = _running.get(conversation_id)
    if turn:
        turn.stop()
        await turn.finished.wait()


async def follow(turn: Turn):
    """The message as far as it has got, then the rest as it arrives."""
    queue: asyncio.Queue = asyncio.Queue()
    turn.readers.add(queue)
    if turn.finished.is_set():
        queue.put_nowait(None)  # it ended before this was listening
    try:
        yield {"text": turn.text}
        while (delta := await queue.get()) is not None:
            yield {"delta": delta}
    finally:
        turn.readers.discard(queue)
