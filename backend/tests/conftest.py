import asyncio
import uuid
from contextlib import asynccontextmanager

import httpx
import pytest


def _default_settings(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("EVERMIND_GATE_PASSWORD", raising=False)
    monkeypatch.delenv("EVERMIND_ALLOWED_HOSTS", raising=False)
    monkeypatch.setenv("EVERMIND_UI_DIR", str(tmp_path / "no-ui"))


@pytest.fixture(autouse=True)
def _no_developer_settings(tmp_path, monkeypatch):
    """What the developer has set must not change what a test sees: a password
    left in the shell would lock every API test, host names allowed there would
    let through names that tests expect refused, and a real built interface
    would answer routes that tests expect to be missing."""
    _default_settings(tmp_path, monkeypatch)


@pytest.fixture()
async def make_client(tmp_path, monkeypatch):
    """Open clients on fresh applications that all share one data directory.

    ``make_client(**env)`` is an async context manager. Each call is a restart:
    a new application, with the defaults above plus ``env``, on the same
    database as the previous one. That is what lets a test log in, change the
    password and see what the next start makes of the old session.
    """
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / f"data-{uuid.uuid4().hex}"))

    @asynccontextmanager
    async def make(**env: str):
        # Start from the defaults every time, so that a call says everything
        # about the configuration it starts with.
        _default_settings(tmp_path, monkeypatch)
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        from app.db import init_db
        from app.main import create_app

        app = create_app()
        await init_db()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
            yield c

    yield make

    # Let fire-and-forget background tasks (memory maintenance) finish before
    # the temp database directory is torn down.
    pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    if pending:
        await asyncio.wait(pending, timeout=2)


@pytest.fixture()
async def client(make_client):
    """HTTP client over the ASGI app, backed by a temporary database."""
    async with make_client() as c:
        yield c
