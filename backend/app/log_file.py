"""``evermind.log``: what went wrong, kept in the data folder for the person who runs the server.

The terminal's lines scroll away, and the owner often uses Evermind from a phone and sees that
terminal days later. The lines of WARNING and above that the application's own loggers and the
server's error logger write are also appended here, as the terminal shows them, each with its date
and time, its level and where it came from, an exception with its traceback: this is the file to
send with a bug report. Never the access lines, and nothing is added to what is logged.

The file turns over past FILE_LIMIT and one older file is kept. A file that cannot be written stops
nothing: the terminal says so once, and the server goes on without it. A file held for a moment by
another program, or written by another server on the same folder, is written again as soon as it
can be, and says how many lines it missed.
"""

import logging
import os
from collections.abc import Callable
from pathlib import Path

from . import config

FILE_NAME = "evermind.log"
FILE_LIMIT = 1024 * 1024

logger = logging.getLogger(__name__)


class _LogFile(logging.Handler):
    def __init__(self, locate: Callable[[], Path]):
        super().__init__(logging.WARNING)
        # Where the file is, asked for at the first line: importing the application must not
        # create the data folder.
        self._locate = locate
        self._path: Path | None = None
        self._given_up = False
        self._quiet = False
        self._written = False  # a line reached the file since the start
        self._lost = 0  # lines not written since the last that was
        self.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        if self._given_up or self._quiet:
            return
        data = (self.format(record) + "\n").encode("utf-8")
        if self._path is None:
            try:
                self._path = self._locate()
            except OSError as error:
                self._give_up(error)
                return
        try:
            size = self._path.stat().st_size
        except OSError:
            size = 0
        if size and size + len(data) > FILE_LIMIT:
            try:
                os.replace(self._path, self._path.with_name(self._path.name + ".1"))
            except OSError:
                # Held by another program (a reader, a backup, another server on the same folder):
                # Windows renames no file that is held open. The line is added all the same, and
                # the turn-over is tried again at the next.
                pass
        if self._lost:
            data = (f"{self._lost} line(s) above could not be written here; the terminal had them.\n"
                    .encode() + data)
        try:
            # Opened for each line and closed at once, for the turn-over above.
            with self._path.open("ab") as file:
                file.write(data)
        except OSError as error:
            if not self._written:
                # Never written: the folder cannot be, and the file is given up.
                self._give_up(error)
                return
            # Written before: held for a moment, it is tried again at the next line.
            if not self._lost:
                self._tell("%s cannot be written for now (%s): what goes wrong is in this terminal "
                           "until it can", error)
            self._lost += 1
            return
        self._written = True
        self._lost = 0

    def _give_up(self, error: OSError) -> None:
        self._given_up = True
        self._tell("%s cannot be written (%s): until the next start, what goes wrong is only in "
                   "this terminal", error)

    def _tell(self, message: str, error: OSError) -> None:
        record = logger.makeRecord(logger.name, logging.WARNING, __file__, 0, message,
                                   (self._path or FILE_NAME, error), None)
        # Not logger.warning: logging drops what is logged from inside a handler, where this runs,
        # against loops. Here this handler is told to write nothing while it says so.
        self._quiet = True
        try:
            logger.callHandlers(record)
        finally:
            self._quiet = False


_attached: list[tuple[logging.Logger, logging.Handler]] = []


def install(locate: Callable[[], Path] = lambda: config.data_dir() / FILE_NAME) -> None:
    """Listen to the application and to the server's errors; what was installed before stops.
    Called by each application that is made, so that each test has its own file."""
    for listened, handler in _attached:
        listened.removeHandler(handler)
    _attached.clear()
    application = logging.getLogger("app")
    # With no handler anywhere above them, the application's lines reach the terminal through
    # logging's last resort, which stops being used once a handler is added: it is added in its
    # own place, so that the terminal gets exactly the lines it got before.
    if not application.hasHandlers() and logging.lastResort is not None:
        application.addHandler(logging.lastResort)
        _attached.append((application, logging.lastResort))
    handler = _LogFile(locate)
    for listened in (application, logging.getLogger("uvicorn.error")):
        listened.addHandler(handler)
        _attached.append((listened, handler))
