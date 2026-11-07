"""Runtime configuration resolved from environment variables."""

import codecs
import importlib.util
import os
import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_DOCKERENV = Path("/.dockerenv")  # Docker puts it in every container

_ENV_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def default_env_file() -> Path:
    """The ``.env`` at the repository root, next to the launch scripts."""
    return _REPO_ROOT / ".env"


def load_env_file(path: Path) -> None:
    """Put the ``KEY=value`` lines of a ``.env`` into the environment, as written:
    quotes belong to the value, and ``#`` starts a comment only at the start of a
    line, because a password may hold one. A variable already set and not empty
    wins over the file. UTF-8 (with or without a byte order mark) and UTF-16
    with one (what PowerShell 5.1 writes) are read; anything else raises ValueError.
    A missing file is not an error."""
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return
    utf16 = data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE))
    text = data.decode("utf-16" if utf16 else "utf-8-sig")
    if "\0" in text:
        raise ValueError("it has NUL bytes: save it as UTF-8, or as UTF-16 with a byte order mark")
    for line in text.split("\n"):
        key, equals, value = line.strip().removeprefix("export ").partition("=")
        key = key.strip()
        if equals and _ENV_KEY.fullmatch(key) and not os.environ.get(key):
            os.environ[key] = value.strip()


def data_dir() -> Path:
    """Where the database and media live. An empty variable means the default,
    like ``ui_dir``: ``EVERMIND_DATA_DIR=`` left in a settings file would
    otherwise start Evermind on a fresh database in the current directory."""
    d = Path(os.environ.get("EVERMIND_DATA_DIR") or _REPO_ROOT / "data")
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return data_dir() / "evermind.db"


def media_dir() -> Path:
    d = data_dir() / "media"
    d.mkdir(parents=True, exist_ok=True)
    return d


def library_dir() -> Path:
    """Starter cards shipped with the repo (read-only)."""
    return Path(os.environ.get("EVERMIND_LIBRARY_DIR") or _REPO_ROOT / "library")


def ui_dir() -> Path:
    """The built interface. An empty variable means the default, not the current
    directory, which is what ``Path("")`` would silently turn it into."""
    return Path(os.environ.get("EVERMIND_UI_DIR") or _REPO_ROOT / "frontend" / "dist")


def gate_password() -> str:
    """Empty means no password, which is the default."""
    return os.environ.get("EVERMIND_GATE_PASSWORD", "").strip()


def semantic_installed() -> bool:
    """Whether the ``semantic`` extra is installed, which it never is in the published image."""
    return importlib.util.find_spec("sentence_transformers") is not None


def install_kind() -> str:
    """``docker`` in a container of the published image, ``built`` in one built from the source,
    ``clone`` where git can update the source, ``zip`` otherwise."""
    if _DOCKERENV.exists():
        # SEMANTIC=true reaches the container through the .env: the image was built, or meant to be.
        built = semantic_installed() or os.environ.get("SEMANTIC") == "true"
        return "built" if built else "docker"
    return "clone" if (_REPO_ROOT / ".git").exists() else "zip"  # .git is a file in a worktree
