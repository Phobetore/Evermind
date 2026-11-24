"""evermind.log: what went wrong, in a file the owner can send with a bug report.

It gets the lines of WARNING and above that the terminal gets, from the application's own loggers
and from the server's error logger, never the access lines, and changes nothing in the terminal.
"""

import asyncio
import logging

from app import config, log_file


def written(path) -> str:
    return path.read_text("utf-8") if path.exists() else ""


def test_a_warning_is_written_and_an_access_line_is_not(tmp_path):
    path = tmp_path / "evermind.log"
    log_file.install(lambda: path)
    logging.getLogger("app.services.memory_service").warning(
        "memory maintenance failed for %s: %s", "c1", "The model only thought.")
    logging.getLogger("uvicorn.error").error("Something went wrong in the server")
    logging.getLogger("uvicorn.access").info('127.0.0.1:5000 - "GET /api/characters HTTP/1.1" 200')
    logging.getLogger("uvicorn.access").warning('127.0.0.1:5000 - "GET /api/x HTTP/1.1" 404')
    logging.getLogger("uvicorn.error").info("Started server process [42]")
    logging.getLogger("app.services.chat_service").info("a line of no concern")
    logging.getLogger("httpx").warning("another library's own line")

    lines = written(path).splitlines()
    assert len(lines) == 2
    assert lines[0].endswith(" WARNING app.services.memory_service: memory maintenance failed for c1: "
                             "The model only thought.")
    assert lines[1].endswith(" ERROR uvicorn.error: Something went wrong in the server")
    # Its date and time first, as 2026-11-23 18:40:21,123.
    assert lines[0][:4].isdigit() and lines[0][4] == "-" and lines[0][10] == " "


def test_an_exception_is_written_with_its_traceback(tmp_path):
    path = tmp_path / "evermind.log"
    log_file.install(lambda: path)
    try:
        raise ValueError("the vector has the wrong length")
    except ValueError:
        logging.getLogger("uvicorn.error").exception("Exception in ASGI application")
    text = written(path)
    assert " ERROR uvicorn.error: Exception in ASGI application\nTraceback (most recent call last):\n" in text
    assert text.endswith("ValueError: the vector has the wrong length\n")


def test_a_request_cut_by_the_stop_is_not_written_as_an_error(tmp_path):
    path = tmp_path / "evermind.log"
    log_file.install(lambda: path)
    server = logging.getLogger("uvicorn.error")
    # What uvicorn logs for a request still running past the stop's grace: the line that says so,
    # then the request's cancellation as an exception.
    server.error("Cancel %s running task(s), timeout graceful shutdown exceeded", 1)
    for cancelled in (asyncio.CancelledError("Task cancelled, timeout graceful shutdown exceeded"),
                      asyncio.CancelledError(), ValueError("Task cancelled, timeout graceful shutdown exceeded")):
        server.error("Exception in ASGI application\n", exc_info=cancelled)
    text = written(path)
    assert "Cancel 1 running task(s), timeout graceful shutdown exceeded" in text
    # Any other cancellation, and any error, is still written.
    assert text.count("Exception in ASGI application") == 2
    assert "\nasyncio.exceptions.CancelledError\n" in text
    assert text.endswith("ValueError: Task cancelled, timeout graceful shutdown exceeded\n")


def test_the_file_turns_over_at_1_mb_and_keeps_one_older(tmp_path, monkeypatch):
    assert log_file.FILE_LIMIT == 1024 * 1024
    monkeypatch.setattr(log_file, "FILE_LIMIT", 2000)
    path = tmp_path / "evermind.log"
    log_file.install(lambda: path)
    for n in range(60):
        logging.getLogger("app.test").warning("line %02d %s", n, "y" * 100)
    older = tmp_path / "evermind.log.1"
    assert path.stat().st_size <= 2000 and older.stat().st_size <= 2000
    assert sorted(p.name for p in tmp_path.iterdir()) == ["evermind.log", "evermind.log.1"]
    assert "line 59" in written(path).splitlines()[-1]
    assert "line 00" not in written(path) + written(older)


def test_a_file_that_cannot_be_written_stops_nothing(tmp_path, capsys):
    # Its folder does not exist, and nothing makes it.
    path = tmp_path / "missing" / "evermind.log"
    root = logging.getLogger()
    saved = root.handlers[:]
    root.handlers.clear()  # the terminal alone, as under the server
    try:
        log_file.install(lambda: path)
        logging.getLogger("app.test").warning("first")
        logging.getLogger("app.test").warning("second")
    finally:
        root.handlers[:] = saved
    err = capsys.readouterr().err.splitlines()
    assert err[0] == "first"
    assert len([line for line in err if "evermind.log" in line]) == 1
    assert "cannot be written" in err[1]
    assert err[-1] == "second"
    assert not path.exists()


def test_the_terminal_gets_the_same_lines_as_before(tmp_path, capsys):
    """Where nothing else handles the application's lines, the terminal has them from logging's
    last resort; the file must not take them from it."""
    root = logging.getLogger()
    saved = root.handlers[:]
    root.handlers.clear()
    try:
        log_file.install(lambda: tmp_path / "evermind.log")
        logging.getLogger("app.test").warning("seen in the terminal")
        logging.getLogger("app.test").info("not seen at all")
    finally:
        root.handlers[:] = saved
    assert capsys.readouterr().err == "seen in the terminal\n"


async def test_the_file_is_in_the_data_folder_and_nowhere_else(make_client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    async with make_client():
        logging.getLogger("app.test").warning("where does this go")
        folder = config.data_dir()
    assert "where does this go" in written(folder / "evermind.log")
    found = [p for p in tmp_path.rglob("evermind.log*")]
    assert found == [folder / "evermind.log"]


def test_a_file_held_at_its_turn_over_goes_on_being_written(tmp_path, monkeypatch):
    """A reader, an editor or a backup holding the file: Windows renames no file held open, so the
    turn-over waits for the next line, and no line is lost meanwhile."""
    monkeypatch.setattr(log_file, "FILE_LIMIT", 2000)
    path = tmp_path / "evermind.log"
    log_file.install(lambda: path)
    log = logging.getLogger("app.test")
    real_replace = log_file.os.replace
    held = True

    def replace(source, target):
        if held:
            raise PermissionError(13, "The process cannot access the file", str(source))
        real_replace(source, target)

    monkeypatch.setattr(log_file.os, "replace", replace)
    for n in range(40):
        log.warning("line %02d %s", n, "y" * 100)
    assert all(f"line {n:02d}" in written(path) for n in range(40))
    held = False
    log.warning("line 40")
    older = tmp_path / "evermind.log.1"
    assert "line 39" in written(older) and written(path).splitlines()[-1].endswith("line 40")


def test_a_file_held_for_a_moment_is_written_again_and_says_what_it_missed(tmp_path, monkeypatch, capsys):
    """Two servers on one folder, or a program that locks the file: the lines of that moment are
    in the terminal, and the file takes the next as soon as it can."""
    path = tmp_path / "evermind.log"
    root = logging.getLogger()
    saved = root.handlers[:]
    root.handlers.clear()
    try:
        log_file.install(lambda: path)
        log = logging.getLogger("app.test")
        log.warning("before")
        real_open = type(path).open
        monkeypatch.setattr(type(path), "open", lambda self, *a, **k: (_ for _ in ()).throw(
            PermissionError(13, "Permission denied", str(self))))
        log.warning("held one")
        log.warning("held two")
        monkeypatch.setattr(type(path), "open", real_open)
        log.warning("after")
        log.warning("later")
    finally:
        root.handlers[:] = saved
    lines = written(path).splitlines()
    assert len(lines) == 4
    assert lines[0].endswith(": before")
    assert lines[1] == "2 line(s) above could not be written here; the terminal had them."
    assert lines[2].endswith(": after") and lines[3].endswith(": later")
    err = capsys.readouterr().err
    assert err.count("cannot be written for now") == 1
    assert "held one" in err and "held two" in err
