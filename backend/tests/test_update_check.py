"""What Settings needs from the server for the notice of a newer release, which the
browser asks GitHub for itself."""

import sys

import pytest

from app import __version__, config


@pytest.mark.parametrize(("install", "platform", "command"), [
    ("docker", "win32", "docker compose up -d --pull always"),
    # Windows PowerShell has no && operator: it is a parse error there.
    ("clone", "win32", r"git pull; .\scripts\prod.ps1"),
    ("clone", "linux", "git pull && ./scripts/prod.sh"),
    ("worktree", "linux", "git pull && ./scripts/prod.sh"),
    # An unzipped folder has nothing for git to pull: Settings sends to INSTALL.md instead.
    ("zip", "win32", None),
])
async def test_the_server_says_what_it_runs_and_the_command_that_updates_it(
        client, monkeypatch, tmp_path, install, platform, command):
    root = tmp_path / "evermind"
    root.mkdir()
    if install == "docker":
        (tmp_path / ".dockerenv").touch()
    elif install == "clone":
        (root / ".git").mkdir()
    elif install == "worktree":
        (root / ".git").write_text("gitdir: elsewhere\n", encoding="utf-8")
    monkeypatch.setattr(config, "_DOCKERENV", tmp_path / ".dockerenv")
    monkeypatch.setattr(config, "_REPO_ROOT", root)
    monkeypatch.setattr(sys, "platform", platform)
    assert (await client.get("/api/update")).json() == {"current": __version__, "command": command}
