"""What Settings needs from the server for the notice of a newer release, which the
browser asks GitHub for itself."""

import sys

import pytest

from app import __version__, config


@pytest.mark.parametrize(("install", "platform", "kind", "command"), [
    ("docker", "win32", "docker", "docker compose up -d --pull always"),
    # .env.example says SEMANTIC=false, and docker-compose.yml hands the .env to the container.
    ("docker, SEMANTIC=false", "linux", "docker", "docker compose up -d --pull always"),
    # The published image, which that command fetches, never has semantic memory: Settings sends
    # an image built from the source to INSTALL.md, which says how to build the new one.
    ("docker, semantic memory", "linux", "built", None),
    ("docker, SEMANTIC=true", "linux", "built", None),
    # Windows PowerShell has no && operator: it is a parse error there.
    ("clone", "win32", "clone", r"git pull; .\scripts\prod.ps1"),
    ("clone", "linux", "clone", "git pull && ./scripts/prod.sh"),
    ("worktree", "linux", "clone", "git pull && ./scripts/prod.sh"),
    # An unzipped folder has nothing for git to pull: Settings sends to INSTALL.md instead.
    ("zip", "win32", "zip", None),
])
async def test_the_server_says_what_it_runs_and_the_command_that_updates_it(
        client, monkeypatch, tmp_path, install, platform, kind, command):
    root = tmp_path / "evermind"
    root.mkdir()
    if install.startswith("docker"):
        (tmp_path / ".dockerenv").touch()
    elif install == "clone":
        (root / ".git").mkdir()
    elif install == "worktree":
        (root / ".git").write_text("gitdir: elsewhere\n", encoding="utf-8")
    monkeypatch.delenv("SEMANTIC", raising=False)
    if "SEMANTIC=" in install:
        monkeypatch.setenv("SEMANTIC", install.split("=")[1])
    monkeypatch.setattr(config, "semantic_installed", lambda: install.endswith("semantic memory"))
    monkeypatch.setattr(config, "_DOCKERENV", tmp_path / ".dockerenv")
    monkeypatch.setattr(config, "_REPO_ROOT", root)
    monkeypatch.setattr(sys, "platform", platform)
    assert (await client.get("/api/update")).json() == {
        "current": __version__, "kind": kind, "command": command}
