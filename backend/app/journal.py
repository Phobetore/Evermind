"""What went wrong on the server, kept where a phone can read it.

The owner often runs Evermind on a computer and uses it from a phone, and a failure was only a
line in a terminal he might see days later. The journal keeps the lines of WARNING and above that
the application's own loggers and the server's error logger already write, never the access
lines, and adds nothing to them: no text of a conversation beyond what those lines carry.

The newest KEPT are held in memory, and each is appended to ``evermind.log`` in the data folder,
one JSON object a line, so that a restart (an update) finds them again. A file that cannot be read
or written stops nothing: the journal then lives in memory alone, and says so once.
"""

import json
import logging
import os
import threading
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from . import config

FILE_NAME = "evermind.log"
KEPT = 300
MESSAGE_LIMIT = 2000
# The file turns over past this, and one older file is kept: two at most, whatever the years.
FILE_LIMIT = 1024 * 1024

logger = logging.getLogger(__name__)


def _line_of(record: logging.LogRecord) -> str:
    """The line as the terminal shows it, and an exception's type and words on the same line in
    place of its traceback, which would be a page on a phone."""
    line = record.getMessage().rstrip()
    error = record.exc_info[1] if record.exc_info else None
    if error is not None:
        words = " ".join(str(error).split())
        line += f": {type(error).__name__}" + (f": {words}" if words else "")
    return line


def _source_of(name: str) -> str:
    return "server" if name.startswith("uvicorn") else name.rpartition(".")[2]


def _is_entry(entry: object) -> bool:
    return (isinstance(entry, dict) and isinstance(entry.get("id"), int)
            and all(isinstance(entry.get(key), str) for key in ("time", "level", "source", "message")))


class Journal:
    def __init__(self, locate: Callable[[], Path]):
        # Where the file is, asked for on first use: importing the application must not create
        # the data folder.
        self._locate = locate
        self._lock = threading.RLock()
        self._entries: deque[dict] = deque(maxlen=KEPT)
        self._next_id = 1
        self.path: Path | None = None
        self._loaded = False
        self._in_memory_only = False

    @property
    def _older(self) -> Path:
        assert self.path is not None
        return self.path.with_name(self.path.name + ".1")

    def load(self) -> None:
        """Read back what the last run kept: once, at start or at first use."""
        with self._lock:
            if self._loaded:
                return
            self._loaded = True
            try:
                self.path = self._locate()
                found: list[dict] = []
                for path in (self._older, self.path):
                    try:
                        text = path.read_text("utf-8", errors="replace")
                    except FileNotFoundError:
                        continue
                    for line in text.splitlines():
                        try:
                            entry = json.loads(line)
                        except ValueError:
                            continue  # a line cut short when the computer went off
                        if _is_entry(entry):
                            found.append(entry)
            except OSError as error:
                self._give_up(error)
                return
            self._entries.extend(found[-KEPT:])
            if found:
                self._next_id = max(entry["id"] for entry in found) + 1

    def add(self, level: str, source: str, message: str) -> None:
        with self._lock:
            self.load()
            entry = {"id": self._next_id, "time": datetime.now(UTC).isoformat(timespec="seconds").replace(
                "+00:00", "Z"), "level": level, "source": source, "message": message[:MESSAGE_LIMIT]}
            self._next_id += 1
            self._entries.append(entry)
            if not self._in_memory_only:
                try:
                    self._append(entry)
                except OSError as error:
                    self._give_up(error)

    def _append(self, entry: dict) -> None:
        assert self.path is not None
        data = (json.dumps(entry, ensure_ascii=False) + "\n").encode("utf-8")
        try:
            size = self.path.stat().st_size
        except FileNotFoundError:
            size = 0
        if size and size + len(data) > FILE_LIMIT:
            os.replace(self.path, self._older)
        # Opened for each line and closed at once: Windows renames no file that is held open.
        with self.path.open("ab") as file:
            file.write(data)

    def _give_up(self, error: OSError) -> None:
        self._in_memory_only = True
        # Not isEnabledFor, which answers no inside a handler, for the reason below.
        if logger.disabled or logger.getEffectiveLevel() > logging.WARNING:
            return
        record = logger.makeRecord(
            logger.name, logging.WARNING, __file__, 0,
            "journal: %s cannot be read or written (%s); what goes wrong is kept in memory only, "
            "until the server restarts", (self.path or FILE_NAME, error), None)
        # Not logger.warning: logging drops what is logged from inside a handler, where this mostly
        # runs, against loops. There is none here: the journal, which gets it too, now writes nothing.
        logger.callHandlers(record)

    def read(self, after: int | None = None, limit: int = 100) -> dict:
        """Newest first; only those with an id above ``after``; ``newest`` whatever the filter."""
        with self._lock:
            self.load()
            newest = self._entries[-1]["id"] if self._entries else None
            entries = [entry for entry in reversed(self._entries) if after is None or entry["id"] > after]
            return {"entries": entries[:limit], "newest": newest}

    def clear(self) -> None:
        """Memory and file. The ids go on growing, so that what comes next is still new to a device."""
        with self._lock:
            self.load()
            self._entries.clear()
            if self._in_memory_only:
                return
            try:
                self.path.unlink(missing_ok=True)
                self._older.unlink(missing_ok=True)
            except OSError as error:
                self._give_up(error)


class _Handler(logging.Handler):
    def __init__(self, journal: Journal):
        super().__init__(logging.WARNING)
        self.journal = journal

    def emit(self, record: logging.LogRecord) -> None:
        try:
            level = "error" if record.levelno >= logging.ERROR else "warning"
            self.journal.add(level, _source_of(record.name), _line_of(record))
        except Exception:  # noqa: BLE001 - logging's own way: said on stderr, and the server goes on
            self.handleError(record)


current = Journal(lambda: config.data_dir() / FILE_NAME)
_attached: list[tuple[logging.Logger, logging.Handler]] = []


def install(locate: Callable[[], Path] = lambda: config.data_dir() / FILE_NAME) -> Journal:
    """A new journal, listening to the application and to the server's errors; the one before
    stops listening. Called by each application that is made, so each test has its own."""
    global current
    for listened, handler in _attached:
        listened.removeHandler(handler)
    _attached.clear()
    current = Journal(locate)
    handler = _Handler(current)
    application = logging.getLogger("app")
    # With no handler anywhere above them, the application's lines reach the terminal through
    # logging's last resort, which stops being used once one is added: it is added in its own
    # place, so that the terminal gets exactly the lines it got before.
    if not application.hasHandlers() and logging.lastResort is not None:
        application.addHandler(logging.lastResort)
        _attached.append((application, logging.lastResort))
    for listened in (application, logging.getLogger("uvicorn.error")):
        listened.addHandler(handler)
        _attached.append((listened, handler))
    return current
