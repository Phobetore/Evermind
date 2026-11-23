"""The journal: what went wrong on the server, kept where a phone can read it.

It keeps what the terminal already gets at WARNING and above, from the application's own
loggers and from the server's error logger, never the access lines, and adds nothing to them.
"""

import json
import logging

import pytest

from app import journal
from app.journal import Journal
from app.providers.base import ProviderError, ProviderEvent

from .conftest import FakeProvider, send, setup_conversation

PW = "s3cret"
LOCKED = {"error": "Locked.", "kind": "locked"}


@pytest.fixture()
def kept(tmp_path):
    """A journal installed as the server installs it, on a file of its own."""
    path = tmp_path / "evermind.log"
    return journal.install(lambda: path), path


def messages(j: Journal) -> list[str]:
    return [e["message"] for e in j.read()["entries"]]


def test_a_warning_is_kept_and_an_access_line_is_not(kept):
    j, _ = kept
    logging.getLogger("app.services.memory_service").warning(
        "memory maintenance failed for %s: %s", "c1", "The model only thought.")
    logging.getLogger("uvicorn.access").info('127.0.0.1:5000 - "GET /api/characters HTTP/1.1" 200')
    logging.getLogger("uvicorn.access").warning('127.0.0.1:5000 - "GET /api/x HTTP/1.1" 404')
    logging.getLogger("uvicorn.error").info("Started server process [42]")
    logging.getLogger("app.services.chat_service").info("a line of no concern")
    logging.getLogger("httpx").warning("another library's own line")

    [entry] = j.read()["entries"]
    assert entry["message"] == "memory maintenance failed for c1: The model only thought."
    assert entry["level"] == "warning"
    assert entry["source"] == "memory_service"
    assert entry["id"] == 1
    assert entry["time"].endswith("Z") and "T" in entry["time"]


def test_the_server_errors_are_kept_as_errors(kept):
    j, _ = kept
    logging.getLogger("uvicorn.error").error("Something went wrong in the server")
    [entry] = j.read()["entries"]
    assert (entry["level"], entry["source"]) == ("error", "server")


def test_an_exception_is_kept_on_one_line_without_its_traceback(kept):
    j, _ = kept
    try:
        raise ValueError("the vector\nhas the wrong length")
    except ValueError:
        logging.getLogger("uvicorn.error").exception("Exception in ASGI application\n")
    [entry] = j.read()["entries"]
    assert entry["message"] == "Exception in ASGI application: ValueError: the vector has the wrong length"
    assert entry["level"] == "error"
    assert "Traceback" not in entry["message"]


def test_the_newest_300_are_kept(kept):
    j, _ = kept
    log = logging.getLogger("app.test")
    for n in range(305):
        log.warning("line %d", n)
    entries = j.read(limit=1000)["entries"]
    assert len(entries) == 300
    assert entries[0]["message"] == "line 304" and entries[-1]["message"] == "line 5"
    assert [e["id"] for e in entries] == list(range(305, 5, -1))


def test_a_long_line_is_cut_at_2000_characters(kept):
    j, path = kept
    logging.getLogger("app.test").warning("x" * 5000)
    [entry] = j.read()["entries"]
    assert len(entry["message"]) == 2000
    assert json.loads(path.read_text("utf-8"))["message"] == entry["message"]


def test_each_line_is_appended_to_the_file(kept):
    _, path = kept
    log = logging.getLogger("app.test")
    log.warning("first")
    log.error("second")
    lines = [json.loads(line) for line in path.read_text("utf-8").splitlines()]
    assert [(e["id"], e["level"], e["message"]) for e in lines] == [
        (1, "warning", "first"), (2, "error", "second")]
    assert set(lines[0]) == {"id", "time", "level", "source", "message"}


def test_the_file_turns_over_at_1_mb_and_keeps_one_older(tmp_path, monkeypatch):
    monkeypatch.setattr(journal, "FILE_LIMIT", 2000)
    path = tmp_path / "evermind.log"
    j = journal.install(lambda: path)
    log = logging.getLogger("app.test")
    for n in range(40):
        log.warning("line %02d %s", n, "y" * 100)
    older = tmp_path / "evermind.log.1"
    assert path.stat().st_size <= 2000 and older.stat().st_size <= 2000
    assert sorted(p.name for p in tmp_path.iterdir()) == ["evermind.log", "evermind.log.1"]
    last = json.loads(path.read_text("utf-8").splitlines()[-1])
    assert last["message"].startswith("line 39")
    assert len(j.read(limit=300)["entries"]) == 40


def test_a_start_reads_the_file_back(tmp_path):
    path = tmp_path / "evermind.log"
    first = journal.install(lambda: path)
    for n in range(5):
        logging.getLogger("app.test").warning("before the update %d", n)
    assert first.read()["newest"] == 5

    again = journal.install(lambda: path)
    assert messages(again)[:2] == ["before the update 4", "before the update 3"]
    logging.getLogger("app.test").warning("after it")
    # The ids go on from where they were, so a device that saw one still knows what is new.
    assert again.read()["entries"][0]["id"] == 6


def test_a_start_reads_back_only_the_newest_300_across_both_files(tmp_path):
    older = [{"id": n, "time": "2026-11-20T10:00:00Z", "level": "warning", "source": "test",
              "message": f"old {n}"} for n in range(1, 201)]
    newer = [{**e, "id": e["id"] + 200, "message": f"new {e['id']}"} for e in older]
    (tmp_path / "evermind.log.1").write_text("".join(json.dumps(e) + "\n" for e in older), "utf-8")
    # A line cut short by a power cut is passed over, not a reason to read nothing.
    (tmp_path / "evermind.log").write_text(
        "".join(json.dumps(e) + "\n" for e in newer) + '{"id": 401, "ti', "utf-8")
    j = Journal(lambda: tmp_path / "evermind.log")
    entries = j.read(limit=300)["entries"]
    assert len(entries) == 300
    assert (entries[0]["id"], entries[-1]["id"]) == (400, 101)


def test_a_file_that_cannot_be_written_stops_nothing(tmp_path, caplog):
    # Its folder does not exist, and nothing makes it.
    path = tmp_path / "missing" / "evermind.log"
    j = journal.install(lambda: path)
    log = logging.getLogger("app.test")
    with caplog.at_level(logging.WARNING):
        log.warning("first")
        log.warning("second")
    said = [r.getMessage() for r in caplog.records if r.name == "app.journal"]
    assert len(said) == 1 and "memory only" in said[0]
    assert messages(j)[0] == "second" and "first" in messages(j)
    assert not path.exists()
    j.clear()
    assert j.read() == {"entries": [], "newest": None}


def test_a_file_that_cannot_be_read_stops_nothing(tmp_path, caplog):
    # A folder where the file should be: neither read nor written.
    path = tmp_path / "evermind.log"
    path.mkdir()
    j = journal.install(lambda: path)
    with caplog.at_level(logging.WARNING):
        logging.getLogger("app.test").warning("still kept")
    assert "still kept" in messages(j)
    assert len([r for r in caplog.records if r.name == "app.journal"]) == 1


def test_the_terminal_still_gets_the_line(tmp_path, capsys):
    """Where nothing else handles the application's lines, the terminal has them from logging's
    last resort; the journal must not take them from it."""
    root = logging.getLogger()
    saved = root.handlers[:]
    root.handlers.clear()
    try:
        journal.install(lambda: tmp_path / "evermind.log")
        logging.getLogger("app.test").warning("seen in the terminal")
        assert capsys.readouterr().err == "seen in the terminal\n"
    finally:
        root.handlers[:] = saved


async def test_the_api_reads_newest_first_after_an_id_and_up_to_a_limit(client):
    log = logging.getLogger("app.test")
    for n in range(1, 151):
        log.warning("line %d", n)

    body = (await client.get("/api/journal")).json()
    assert body["newest"] == 150
    assert len(body["entries"]) == 100
    assert body["entries"][0]["message"] == "line 150"

    body = (await client.get("/api/journal?after=145")).json()
    assert [e["id"] for e in body["entries"]] == [150, 149, 148, 147, 146]
    assert body["newest"] == 150

    body = (await client.get("/api/journal?limit=3")).json()
    assert [e["id"] for e in body["entries"]] == [150, 149, 148]

    for n in range(200):
        log.warning("more %d", n)
    assert len((await client.get("/api/journal?limit=5000")).json()["entries"]) == 300

    assert (await client.get("/api/journal?limit=0")).status_code == 422
    assert (await client.get("/api/journal?after=x")).status_code == 422


async def test_an_empty_journal_has_no_newest(client):
    assert (await client.get("/api/journal")).json() == {"entries": [], "newest": None}


async def test_a_request_that_failed_on_the_model_is_kept_as_the_terminal_says_it(client, monkeypatch):
    convo = await setup_conversation(client)
    FakeProvider.script = [ProviderEvent(type="delta", text="*She nods.*"), ProviderEvent(type="done")]
    monkeypatch.setattr("app.services.chat_service.get_provider", FakeProvider)
    monkeypatch.setattr("app.services.memory_service.schedule_if_due", lambda convo_id: None)
    await send(client, convo["id"])
    FakeProvider.script = [ProviderError("http://localhost:1234/v1", "unreachable")]

    r = await client.post(f"/api/conversations/{convo['id']}/impersonate")
    assert r.status_code == 502
    [entry] = (await client.get("/api/journal")).json()["entries"]
    assert entry["message"] == (f"POST /api/conversations/{convo['id']}/impersonate failed with "
                                "unreachable: http://localhost:1234/v1")
    assert (entry["level"], entry["source"]) == ("warning", "errors")


async def test_delete_empties_the_memory_and_the_file(client, tmp_path):
    logging.getLogger("app.test").warning("to be cleared")
    path = journal.current.path
    assert path is not None and path.is_file()
    (path.parent / "evermind.log.1").write_text("", "utf-8")

    r = await client.delete("/api/journal")
    assert r.status_code == 204
    assert (await client.get("/api/journal")).json() == {"entries": [], "newest": None}
    assert not path.exists() and not (path.parent / "evermind.log.1").exists()

    # What comes after has a larger id still, so a device knows it is new.
    logging.getLogger("app.test").warning("after the clearing")
    assert (await client.get("/api/journal")).json()["newest"] == 2


async def test_delete_from_another_origin_is_refused(client):
    logging.getLogger("app.test").warning("stays")
    r = await client.delete("/api/journal", headers={"origin": "http://evil.example"})
    assert (r.status_code, r.json()["kind"]) == (403, "cross_origin")
    assert (await client.get("/api/journal")).json()["newest"] == 1
    r = await client.delete("/api/journal", headers={"origin": "http://localhost"})
    assert r.status_code == 204


@pytest.mark.parametrize("method", ["GET", "DELETE"])
async def test_the_journal_is_behind_the_password(make_client, method):
    async with make_client(EVERMIND_GATE_PASSWORD=PW) as c:
        logging.getLogger("app.test").warning("not for strangers")
        r = await c.request(method, "/api/journal")
        assert (r.status_code, r.json()) == (401, LOCKED)
        await c.post("/api/gate", json={"password": PW})
        assert (await c.get("/api/journal")).json()["newest"] == 1
