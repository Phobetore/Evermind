"""``evermind.log``: what went wrong, kept in the data folder for the person who runs the server.

The terminal's lines scroll away, and the owner often uses Evermind from a phone and sees that
terminal days later. The lines of WARNING and above that the application's own loggers and the
server's error logger write are also appended here, as the terminal shows them, each with its date
and time, its level and where it came from, an exception with its traceback: this is the file to
send with a bug report. Never the access lines, and nothing is added to what is logged.

The file turns over past FILE_LIMIT and one older file is kept. A file that cannot be written stops
nothing: the terminal says so once, and the server goes on without it.
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
        self.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        if self._given_up:
            return
        try:
            data = (self.format(record) + "\n").encode("utf-8")
            if self._path is None:
                self._path = self._locate()
            try:
                size = self._path.stat().st_size
            except FileNotFoundError:
                size = 0
            if size and size + len(data) > FILE_LIMIT:
                os.replace(self._path, self._path.with_name(self._path.name + ".1"))
            # Opened for each line and closed at once: Windows renames no file that is held open.
            with self._path.open("ab") as file:
                file.write(data)
        except OSError as error:
            self._give_up(error)

    def _give_up(self, error: OSError) -> None:
        self._given_up = True
        record = logger.makeRecord(
            logger.name, logging.WARNING, __file__, 0,
            "%s cannot be written (%s): until the next start, what goes wrong is only in this terminal",
            (self._path or FILE_NAME, error), None)
        # Not logger.warning: logging drops what is logged from inside a handler, where this runs,
        # against loops. There is none here: this handler now writes nothing.
        logger.callHandlers(record)


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
