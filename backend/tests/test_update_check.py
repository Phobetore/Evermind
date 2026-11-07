"""What Settings needs from the server for the notice of a newer release, which the
browser asks GitHub for itself."""

import sys

import pytest

from app import __version__, config


@pytest.mark.parametrize(("kind", "platform", "command"), [
    ("docker", "win32", "docker compose up -d --pull always"),
    # Windows PowerShell has no && operator: it is a parse error there.
    ("source", "win32", r"git pull; .\scripts\prod.ps1"),
    ("source", "linux", "git pull && ./scripts/prod.sh"),
])
async def test_the_server_says_what_it_runs_and_the_command_that_updates_it(
        client, monkeypatch, kind, platform, command):
    monkeypatch.setattr(config, "install_kind", lambda: kind)
    monkeypatch.setattr(sys, "platform", platform)
    assert (await client.get("/api/update")).json() == {"current": __version__, "command": command}
