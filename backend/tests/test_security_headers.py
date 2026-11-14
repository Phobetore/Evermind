"""Every answer of the server carries the security headers, and they cost nothing to a stream.

The policy is written out here in full: a change to it has to be meant.
"""

import asyncio

import httpx
import pytest
from fastapi.routing import APIRoute

from app.config import media_dir
from app.headers import CONTENT_SECURITY_POLICY, SecurityHeaders

POLICY = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self'; "
    "img-src 'self' data: blob: https:; "
    "font-src 'self' data:; "
    "connect-src 'self' https://api.github.com https://gateway.chub.ai https://avatars.charhub.io"
    " https://realm.risuai.net; "
    "media-src 'none'; "
    "object-src 'none'; "
    "frame-src 'none'; "
    "base-uri 'none'; "
    "form-action 'self'"
)

EXPECTED = {
    "content-security-policy": POLICY,
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-dns-prefetch-control": "off",
}

STORED = "0" * 32 + ".png"


@pytest.fixture()
def ui_dir(tmp_path):
    root = tmp_path / "ui"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text('<!doctype html><div id="root"></div>', encoding="utf-8")
    (root / "assets" / "app-3f2a1b.js").write_text("console.log('app')", encoding="utf-8")
    (root / "assets" / "app-3f2a1b.mjs").write_text("console.log('app')", encoding="utf-8")
    (root / "assets" / "app-3f2a1b.css").write_text("body{margin:0}", encoding="utf-8")
    return root


@pytest.fixture()
async def ui_client(make_client, ui_dir):
    async with make_client(EVERMIND_UI_DIR=str(ui_dir)) as c:
        yield c


def assert_carries_them(response: httpx.Response) -> None:
    for name, value in EXPECTED.items():
        assert response.headers.get_list(name) == [value], name


def test_the_policy_is_the_one_written_down():
    assert CONTENT_SECURITY_POLICY == POLICY


@pytest.mark.parametrize(("path", "status"), [
    ("/", 200),
    ("/assets/app-3f2a1b.js", 200),
    ("/api/health", 200),
    ("/api/nowhere", 404),
    ("/chat", 302),
    (f"/api/media/{STORED}", 200),
])
async def test_every_answer_carries_the_security_headers(ui_client, path, status):
    (media_dir() / STORED).write_bytes(b"\x89PNG\r\n\x1a\n")
    response = await ui_client.get(path)
    assert response.status_code == status
    assert_carries_them(response)


async def test_an_unhandled_error_is_the_one_answer_without_them(tmp_path, monkeypatch):
    # Starlette's ServerErrorMiddleware wraps every middleware that is added, and writes this
    # answer itself: plain text, which loads nothing. If it ever carries the headers, turn this round.
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "data"))
    from app.db import init_db
    from app.main import create_app

    app = create_app()
    await init_db()

    async def boom():
        raise RuntimeError("boom")

    # First, so that no wider route answers before it.
    app.router.routes.insert(0, APIRoute("/boom", boom, methods=["GET"]))
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
        response = await client.get("/boom")
    assert response.status_code == 500
    assert response.headers["content-type"].split(";")[0] == "text/plain"
    assert "content-security-policy" not in response.headers


async def test_a_refusal_of_the_gate_carries_them_too(make_client):
    async with make_client(EVERMIND_GATE_PASSWORD="x") as client:
        locked = await client.get("/api/characters")
        assert locked.status_code == 401
        assert_carries_them(locked)
        foreign = await client.post("/api/characters", json={"name": "Vane"},
                                    headers={"Origin": "http://evil.example"})
        assert foreign.status_code == 403
        assert_carries_them(foreign)


async def test_the_headers_do_not_hold_back_a_stream():
    release = asyncio.Event()
    first = asyncio.Event()
    sent: list[dict] = []

    async def streaming(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"first", "more_body": True})
        await release.wait()
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)
        if message.get("body") == b"first":
            first.set()

    scope = {"type": "http", "method": "GET", "path": "/", "headers": []}
    task = asyncio.create_task(SecurityHeaders(streaming)(scope, receive, send))
    try:
        await asyncio.wait_for(first.wait(), 2)
        assert not release.is_set()
    finally:
        release.set()
        await asyncio.wait_for(task, 2)
    start = dict(sent[0]["headers"])
    assert start[b"x-content-type-options"] == b"nosniff"
    assert [m.get("more_body", False) for m in sent[1:]] == [True, False]


async def test_a_script_and_a_stylesheet_are_served_with_their_types(ui_client):
    for path, kind in [("/assets/app-3f2a1b.js", "text/javascript"),
                       ("/assets/app-3f2a1b.mjs", "text/javascript"),
                       ("/assets/app-3f2a1b.css", "text/css")]:
        response = await ui_client.get(path)
        assert response.status_code == 200, path
        assert response.headers["content-type"].split(";")[0].strip() == kind, path
