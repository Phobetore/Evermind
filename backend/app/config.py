"""Runtime configuration resolved from environment variables."""

import codecs
import os
import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

_ENV_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def default_env_file() -> Path:
    """The ``.env`` at the repository root, next to the launch scripts."""
    return _REPO_ROOT / ".env"


def load_env_file(path: Path) -> None:
    """Put the ``KEY=value`` lines of a ``.env`` into the environment, as written:
    quotes belong to the value, and ``#`` starts a comment only at the start of a
    line, because a password may hold one. A variable already set and not empty
    wins over the file. UTF-8 and UTF-16 (what PowerShell 5.1 writes) are read,
    with or without a byte order mark; anything else raises ValueError.
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


def allowed_hosts() -> list[str]:
    """The host names, besides addresses, localhost, names ending in .localhost
    and this computer's own name (alone or followed by .local; for a name with a
    domain, its first label too, alone or followed by .local), that the API
    answers to without a password. Comma-separated; empty entries are dropped."""
    raw = os.environ.get("EVERMIND_ALLOWED_HOSTS", "")
    return [name.strip() for name in raw.split(",") if name.strip()]
