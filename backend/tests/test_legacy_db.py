"""What the browser suite starts on: a database as the release before AIs left it, with one
connection on an LM Studio of the fake model's. The update makes it an AI brought over, whose first
read finds LM Studio by its probes, and the size it loads changes when the suite asks."""

import importlib.util
import json
import sqlite3
import sys
import threading
from pathlib import Path

import httpx
import pytest

from app import __version__, db
from app.providers import catalog

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def _load(name: str):
    saved = sys.argv
    sys.argv = [name]  # the mock's port comes from the command line, which is pytest's here
    try:
        spec = importlib.util.spec_from_file_location(f"{name}_under_test", SCRIPTS / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.argv = saved
    return module


@pytest.fixture(scope="module")
def mock():
    module = _load("mock_llm")
    module.WORD_DELAY = 0
    server = module.Server(("127.0.0.1", 0), module.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_address[1]
    server.shutdown()
    server.server_close()


async def test_the_legacy_database_is_brought_over_as_one_ai_that_changes_nothing(tmp_path,
                                                                                 monkeypatch):
    folder = tmp_path / "data"
    _load("make_legacy_db").write(folder, 5761)
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(folder))

    await db.init_db()

    assert (folder / f"evermind.before-{__version__}.db").exists()
    conn = sqlite3.connect(folder / "evermind.db")
    conn.row_factory = sqlite3.Row
    try:
        ais = [dict(r) for r in conn.execute("SELECT * FROM models")]
        services = [dict(r) for r in conn.execute("SELECT * FROM connections")]
    finally:
        conn.close()
    assert len(ais) == 1 and len(services) == 1
    ai, service = ais[0], services[0]
    assert (ai["name"], ai["model"], ai["migrated"]) == ("Brume 12B", "brume-12b", 1)
    assert (ai["context_own"], ai["reply_cap_mode"], ai["reply_cap_tokens"]) == (16384, "fixed", 1024)
    assert ai["is_default"] == 0
    assert service["name"] == "Brume 12B"
    assert service["base_url"] == "http://127.0.0.1:5761/lmstudio/v1"
    assert service["family"] == "generic"


def test_a_database_already_there_is_never_written_over(tmp_path):
    folder = tmp_path / "data"
    folder.mkdir()
    (folder / "evermind.db").write_bytes(b"kept")
    with pytest.raises(SystemExit):
        _load("make_legacy_db").write(folder, 5761)
    assert (folder / "evermind.db").read_bytes() == b"kept"


async def test_its_lm_studio_is_found_by_the_probes_and_loads_what_the_suite_asks(mock, monkeypatch):
    monkeypatch.setattr(catalog, "client_factory", lambda: httpx.AsyncClient())
    service = {"provider": "openai-compatible", "base_url": f"http://127.0.0.1:{mock}/lmstudio/v1",
               "api_key": "", "family": "generic", "family_url": None}
    listed, family = await catalog.read_one(service, "brume-12b", fresh=True)
    assert family == "lmstudio"
    assert (listed.served, listed.max) == (32768, 131072)

    async with httpx.AsyncClient() as client:
        root = f"http://127.0.0.1:{mock}/lmstudio"
        # Nothing else is answered under it: no other family's probe finds a shape of its own.
        assert (await client.get(f"{root}/api/ps")).status_code == 404
        changed = await client.post(f"{root}/loaded", json={"context_length": 65536})
        assert changed.status_code == 200
        try:
            listed, _ = await catalog.read_one(service, "brume-12b", fresh=True)
            assert listed.served == 65536
            # Kept until it is read fresh: the cache answers for the same service.
            listed, _ = await catalog.read_one(service, "brume-12b")
            assert listed.served == 65536
        finally:
            await client.post(f"{root}/loaded", json={"context_length": 32768})
        # Its replies are the fake model's own.
        async with client.stream("POST", f"{root}/v1/chat/completions", json={
                "model": "brume-12b", "stream": True,
                "messages": [{"role": "user", "content": "Hello."}]}) as reply:
            assert reply.status_code == 200
            # Read to its last line: the stream sends no length, and stays open.
            async for line in reply.aiter_lines():
                if line.startswith("data: {"):
                    assert json.loads(line[6:])["choices"]
                    break
