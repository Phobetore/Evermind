"""Shared test fixtures."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

# Point the database at a temporary file for tests
_tmp_dir = tempfile.mkdtemp()
os.environ["DATABASE_PATH"] = str(Path(_tmp_dir) / "test.db")

import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from app.core.database import init_db  # noqa: E402
from app.core.middleware import RateLimitMiddleware  # noqa: E402
from app.main import app  # noqa: E402


def _reset_rate_limiter(app_instance) -> None:  # noqa: ANN001
    """Walk the ASGI middleware stack and reset any RateLimitMiddleware."""
    current = getattr(app_instance, "middleware_stack", None)
    while current is not None:
        if isinstance(current, RateLimitMiddleware):
            current.reset()
            return
        current = getattr(current, "app", None)


@pytest_asyncio.fixture
async def client() -> AsyncIterator[AsyncClient]:
    """Yield a test HTTP client backed by the ASGI app."""
    await init_db()
    _reset_rate_limiter(app)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
