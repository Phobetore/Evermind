"""evermind.log: what went wrong, in a file the owner can send with a bug report.

It gets the lines of WARNING and above that the terminal gets, from the application's own loggers
and from the server's error logger, never the access lines, and changes nothing in the terminal.
"""

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
