import asyncio
import uuid

import httpx
import pytest


@pytest.fixture()
async def client(tmp_path, monkeypatch):
    """HTTP client over the ASGI app, backed by a temporary database."""
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / f"data-{uuid.uuid4().hex}"))
    from app.db import init_db
    from app.main import create_app

    app = create_app()
    await init_db()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c

    # Let fire-and-forget background tasks (memory maintenance) finish before
    # the temp database directory is torn down.
    pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    if pending:
        await asyncio.wait(pending, timeout=2)
