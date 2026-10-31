"""The prefix a reverse proxy serves Evermind under, from the command line to
the redirect of an old bookmark.

The pieces are tested where they live: the setting in ``test_launch.py``, the
redirect with a prefix in ``test_ui_serving.py``. This one starts a real server,
because what is left to check is that uvicorn is told the prefix and tells the
application the way the redirect expects. Nothing else in the suite does that, so
it takes care to stop the server again, and to have nothing but its own settings.
"""

import http.client
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get_when_up(port: int, path: str, server: subprocess.Popen) -> http.client.HTTPResponse:
    """The answer to a GET, once the server is accepting connections."""
    deadline = time.monotonic() + 30
    while True:
        try:
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            connection.request("GET", path)
            return connection.getresponse()
        except OSError:
            if server.poll() is not None or time.monotonic() > deadline:
                raise
            time.sleep(0.2)


@pytest.mark.parametrize(
    ("flag", "path", "location"),
    [
        (["--root-path", "/evermind"], "/chat/abc", "/evermind/#/chat/abc"),
        # Written the way a proxy's own configuration writes it.
        (["--root-path", "/apps/evermind/"], "/settings", "/apps/evermind/#/settings"),
        ([], "/chat/abc", "/#/chat/abc"),
    ],
)
def test_an_old_bookmark_lands_under_the_prefix(tmp_path, flag, path, location):
    ui = tmp_path / "ui"
    ui.mkdir()
    (ui / "index.html").write_text("<!doctype html>", encoding="utf-8")
    env = {
        name: value
        for name, value in os.environ.items()
        if name not in ("PORT", "BIND") and not name.startswith("EVERMIND_")
    }
    env["EVERMIND_UI_DIR"] = str(ui)
    env["EVERMIND_DATA_DIR"] = str(tmp_path / "data")
    port = free_port()
    server = subprocess.Popen(
        [sys.executable, "-m", "app", "--no-env-file", "--port", str(port), *flag],
        cwd=BACKEND_DIR, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        # The request a proxy passes on: the prefix is already taken off.
        response = get_when_up(port, path, server)
        assert response.status == 302
        assert response.getheader("Location") == location
    finally:
        server.terminate()
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
