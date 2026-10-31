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


def load_env_file(path: Path) -> list[str]:
    """Put the settings of a ``.env`` file into the environment; return the keys set.

    The file is read here rather than by the launch scripts because bash and
    PowerShell each read it a little differently, and a setting that one of them
    misreads is silent: a password that looks configured and is never asked for.
    The format is the plain ``KEY=value`` one, with these decisions made on
    purpose:

    - The file may start with a byte order mark and use CRLF line endings, which
      is what Notepad and PowerShell write. Neither may end up in a key or value.
    - UTF-16 is understood as well as UTF-8, because that is what ``>`` and
      ``Out-File`` write in Windows PowerShell 5.1. It is recognised by its byte
      order mark, which that PowerShell always writes.
    - There are no trailing comments. ``#`` starts a comment only at the start of
      a line, because a password is allowed to contain one.
    - A variable that is already set and not empty wins over the file, so that
      ``PORT=3001 python -m app`` does what it says. An empty one does not: the
      launch scripts always treated it as unset.

    A missing file is not an error. One that exists but cannot be read, or is not
    text in either encoding, raises OSError or UnicodeError, before anything has
    been set.
    """
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return []
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        text = data.decode("utf-16")
    else:
        text = data.decode("utf-8-sig")
    keys: list[str] = []
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        key, equals, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not equals or not _ENV_KEY.fullmatch(key):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if os.environ.get(key):
            continue
        os.environ[key] = value
        if key not in keys:
            keys.append(key)
    return keys


def data_dir() -> Path:
    d = Path(os.environ.get("EVERMIND_DATA_DIR", _REPO_ROOT / "data"))
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
    return Path(os.environ.get("EVERMIND_LIBRARY_DIR", _REPO_ROOT / "library"))


def ui_dir() -> Path:
    """The built interface. An empty variable means the default, not the current
    directory, which is what ``Path("")`` would silently turn it into."""
    return Path(os.environ.get("EVERMIND_UI_DIR") or _REPO_ROOT / "frontend" / "dist")


def gate_password() -> str:
    """Empty means no password, which is the default."""
    return os.environ.get("EVERMIND_GATE_PASSWORD", "")
