import aiosqlite
from fastapi import APIRouter, Depends

from ..db import get_db
from ..errors import NotFoundError
from ..models.schemas import ConnectionIn, ConnectionUpdate
from ..providers import ProviderError, get_provider
from ..repositories import connections as repo
from ..repositories import settings as settings_repo

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
    updated = await repo.update(db, conn_id, payload.model_dump(exclude_unset=True))
    if not updated:
        raise NotFoundError("Connection not found.")
    return updated


@router.delete("/{conn_id}", status_code=204)
async def delete_connection(conn_id: str, db: aiosqlite.Connection = Depends(get_db)):
    if not await repo.delete(db, conn_id):
        raise NotFoundError("Connection not found.")
    await settings_repo.forget(db, "default_connection_id", conn_id)


@router.post("/test")
async def test_connection_payload(payload: ConnectionIn):
    """Test a connection config before saving it."""
    try:
        return await get_provider(payload.model_dump()).test()
    except ProviderError as exc:
        return {"ok": False, "detail": exc.message}


@router.post("/{conn_id}/test")
async def test_connection(conn_id: str, db: aiosqlite.Connection = Depends(get_db)):
    connection = await repo.get_raw(db, conn_id)
    if not connection:
        raise NotFoundError("Connection not found.")
    try:
        return await get_provider(connection).test()
    except ProviderError as exc:
        return {"ok": False, "detail": exc.message}


@router.post("/{conn_id}/benchmark")
async def benchmark_connection(conn_id: str, db: aiosqlite.Connection = Depends(get_db)):
    """Small real generation to measure first-token latency and tokens/s."""
    import time

    from ..prompting.engine import PromptPayload
    from ..prompting.tokens import estimate_tokens

    connection = await repo.get_raw(db, conn_id)
    if not connection:
        raise NotFoundError("Connection not found.")
    connection = dict(connection, max_tokens=96)
    payload = PromptPayload(
        system="You are a speed test. Reply in plain prose.",
        messages=[{"role": "user", "content":
                   "Describe rain falling on a quiet street, in about 60 words."}],
        stop=[],
    )
    chunks: list[str] = []
    started = time.monotonic()
    first_token = None
    try:
        async for event in get_provider(connection).stream_chat(payload):
            if event.type == "delta":
                if first_token is None:
                    first_token = time.monotonic()
                chunks.append(event.text)
            elif event.type == "error":
                return {"ok": False, "detail": event.message}
    except ProviderError as exc:
        return {"ok": False, "detail": exc.message}
    now = time.monotonic()
    if not chunks or first_token is None:
        return {"ok": False, "detail": "No text generated."}
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
        raise NotFoundError("Connection not found.")
    try:
        return {"models": await get_provider(connection).list_models()}
    except ProviderError as exc:
        return {"models": [], "error": exc.message}
