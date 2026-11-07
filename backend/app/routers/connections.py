import aiosqlite
from fastapi import APIRouter, Depends

from ..db import get_db
from ..errors import NotFoundError, failure_fields
from ..models.schemas import ConnectionIn, ConnectionUpdate
from ..providers import ProviderError, get_provider
from ..providers.base import NO_TEXT
from ..repositories import connections as repo

router = APIRouter(prefix="/api/connections", tags=["connections"])


@router.get("")
async def list_connections(db: aiosqlite.Connection = Depends(get_db)):
    return await repo.list_all(db)


@router.post("", status_code=201)
async def create_connection(payload: ConnectionIn, db: aiosqlite.Connection = Depends(get_db)):
    return await repo.create(db, payload.model_dump())


@router.put("/{conn_id}")
async def update_connection(conn_id: str, payload: ConnectionUpdate,
                            db: aiosqlite.Connection = Depends(get_db)):
    updated = await repo.update(db, conn_id, payload.model_dump())
    if not updated:
        raise NotFoundError("Connection not found.", "connection")
    return updated


@router.delete("/{conn_id}", status_code=204)
async def delete_connection(conn_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await repo.delete(db, conn_id):
        raise NotFoundError("Connection not found.", "connection")


@router.post("/test")
async def test_connection_payload(payload: ConnectionIn):
    """Test a connection config before saving it."""
    return await get_provider(payload.model_dump()).test()


@router.post("/{conn_id}/test")
async def test_connection(conn_id: str, db: aiosqlite.Connection = Depends(get_db)):
    connection = await repo.get_raw(db, conn_id)
    if not connection:
        raise NotFoundError("Connection not found.", "connection")
    return await get_provider(connection).test()


@router.post("/{conn_id}/benchmark")
async def benchmark_connection(conn_id: str, db: aiosqlite.Connection = Depends(get_db)):
    """Small real generation to measure first-token latency and tokens/s."""
    import time

    from ..prompting.engine import PromptPayload
    from ..prompting.tokens import estimate_tokens

    connection = await repo.get_raw(db, conn_id)
    if not connection:
        raise NotFoundError("Connection not found.", "connection")
    payload = PromptPayload(
        system="You are a speed test. Reply in plain prose.",
        messages=[{"role": "user", "content":
                   "Describe rain falling on a quiet street, in about 60 words."}],
        stop=[],
    )
    chunks: list[str] = []
    started = time.monotonic()
    first_token = None
    async for event in get_provider(connection).stream_chat(payload):
        if event.type == "delta":
            if first_token is None:
                first_token = time.monotonic()
            chunks.append(event.text)
        elif event.type == "error":
            return {"ok": False, "detail": event.message, **failure_fields(event.meta)}
    now = time.monotonic()
    if not chunks or first_token is None:
        return {"ok": False, "detail": "No text generated.", "kind": NO_TEXT}
    tokens = estimate_tokens("".join(chunks))
    gen_time = max(0.05, now - first_token)
    return {
        "ok": True,
        "first_token_seconds": round(first_token - started, 2),
        "tokens_per_s": round(tokens / gen_time, 1),
        "tokens": tokens,
    }


@router.get("/{conn_id}/models")
async def list_models(conn_id: str, db: aiosqlite.Connection = Depends(get_db)):
    connection = await repo.get_raw(db, conn_id)
    if not connection:
        raise NotFoundError("Connection not found.", "connection")
    try:
        return {"models": await get_provider(connection).list_models()}
    except ProviderError as exc:
        return {"models": [], "error": exc.message, **exc.meta}
