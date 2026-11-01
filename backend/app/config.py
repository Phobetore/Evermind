"""Runtime configuration resolved from environment variables."""

import codecs
import os
import re
from collections.abc import Mapping
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

_ENV_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def default_env_file() -> Path:
    """The ``.env`` at the repository root, next to the launch scripts."""
    return _REPO_ROOT / ".env"


def _settings_text(data: bytes) -> str:
    """The text of a settings file, in UTF-8, UTF-16 or UTF-32.

    A byte order mark says which. The UTF-32 ones are looked for first: the
    little-endian one starts with the little-endian mark of UTF-16, and read as
    UTF-16 the file would come out with a NUL between its letters and not one
    key. Without a mark, a file that starts with ASCII characters gives itself
    away by its NUL bytes: UTF-16 puts one after each character in little-endian
    and before each in big-endian. UTF-32 without a mark has NULs on both sides,
    which fits neither, and is refused rather than guessed at.
    """
    if data.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        return data.decode("utf-32")
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return data.decode("utf-16")
    head = data[:8]
    after, before = head[1::2].count(0), head[0::2].count(0)
    if after and not before:
        return data.decode("utf-16-le")
    if before and not after:
        return data.decode("utf-16-be")
    if after and before:
        raise UnicodeError("NUL bytes that fit neither byte order of UTF-16")
    return data.decode("utf-8-sig")


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
      ``Out-File`` write in Windows PowerShell 5.1. That PowerShell always writes
      a byte order mark; other tools may not, and the NUL bytes show the order.
      UTF-32 is understood too when it starts with its mark, as
      ``Out-File -Encoding utf32`` writes it.
    - There are no trailing comments. ``#`` starts a comment only at the start of
      a line, because a password is allowed to contain one.
    - A variable that is already set and not empty wins over the file, so that
      ``PORT=3001 python -m app`` does what it says. An empty one does not: the
      launch scripts always treated it as unset.

    A missing file is not an error. One that exists but cannot be read, or is not
    text in any of these encodings, raises OSError or UnicodeError, before
    anything has been set.
    """
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return []
    keys: list[str] = []
    for raw in _settings_text(data).split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
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
    return os.environ.get("EVERMIND_GATE_PASSWORD", "")


def parse_root_path(raw: str, name: str) -> str:
    """The path prefix a reverse proxy serves Evermind under, as uvicorn wants
    it: a path that starts with a slash and does not end with one, and nothing
    at all for the root. ``name`` is the setting to blame when it is not one.

    A trailing slash is taken off rather than refused, since ``/evermind/`` is
    how the same prefix looks in a proxy's own configuration. Anything that
    could not be part of a path is refused here, because it would only come
    back as a redirect that leads nowhere, or somewhere else: a query, a
    fragment or whitespace; ``//`` anywhere, which at the start is another site
    to a browser that follows the redirect; a backslash, which a browser reads as
    a slash; a ``%``, which hides dots and slashes from these checks until
    something decodes it; and a ``.`` or ``..`` segment, which a browser or a
    proxy resolves away.
    """
    path = raw.strip()
    if not path:
        return ""
    if not path.startswith("/"):
        raise ValueError(f"{name} must start with /, got {raw!r}")
    kept = path.rstrip("/")
    if re.search(r"[\s?#\\%]", path) or path.startswith("//") or "//" in kept:
        raise ValueError(f"{name} must be a plain path such as /evermind, got {raw!r}")
    if any(segment in (".", "..") for segment in kept.split("/")):
        raise ValueError(f"{name} must be a plain path such as /evermind, got {raw!r}")
    return kept


def root_path(env: Mapping[str, str] | None = None) -> str:
    """The path Evermind is served under by a reverse proxy that removes it
    before passing the request on, from EVERMIND_ROOT_PATH. Empty, the default,
    means it is served at the root. The server needs to be told: it is what lets
    the redirect of an old bookmark go to the right place.

    Raises ValueError for a value that is not a path prefix."""
    source = os.environ if env is None else env
    return parse_root_path(source.get("EVERMIND_ROOT_PATH", ""), "EVERMIND_ROOT_PATH")


def allowed_hosts() -> list[str]:
    """The host names, besides addresses, localhost, names ending in .localhost
    and this computer's own name (alone or followed by .local, and for a name
    with a domain also its first label), that the API answers to without a
    password. Comma-separated; empty entries are dropped."""
    raw = os.environ.get("EVERMIND_ALLOWED_HOSTS", "")
    return [name.strip() for name in raw.split(",") if name.strip()]
