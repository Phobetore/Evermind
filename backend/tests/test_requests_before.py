"""The requests each connection sent to its model before connections became services and AIs, kept
in fixtures/requests_before.json so that the update can be shown to send every model the same ones.

Five connections, written by SQL with fixed ids and dates, one conversation each, and for each of
them the four calls that reach a model: a turn, the ghostwriter, a memory pass and a card from the
assistant (the speed test, run by hand, is not one). The file holds those rows under "seed", as
they read once written, and the body each call sent, with the turn's meta.context.

It is recorded, never written by hand, on the code of the release before this update:
``python -m tests.test_requests_before --record`` from backend/ of a throwaway copy of that code
(``git worktree add --detach <folder> <commit>``, this file copied into its tests/), then the file
brought back and the copy removed. The release before is commit 9d3626d until it is on main; once
it is, after any merge of main that touches backend/app/prompting, backend/app/providers,
chat_service.py, memory_service.py, card_assistant.py or backend/tests/cases, it is recorded
again the same way on origin/main itself.
"""

import asyncio
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

import httpx

RECORDED = Path(__file__).resolve().parent / "fixtures" / "requests_before.json"

# The order rows are written in: each one names only rows written before it.
TABLES = ("personas", "characters", "connections", "conversations", "messages")

OPENROUTER = "https://openrouter.ai/api/v1"
ROUTED_MODEL = "aurore/aurore-large"

# (id, name, provider, base_url, api_key, model, context_size, max_tokens, temperature, top_p,
#  frequency_penalty, presence_penalty). The windows leave a card's room, so that the assistant
# never refuses its brief before asking (card_assistant._check_fits).
CONNECTIONS = (
    ("c-ollama", "Brume", "openai-compatible", "http://localhost:11434/v1", "", "brume:12b",
     16384, 1024, 0.8, 0.95, 0.15, 0.15),
    ("c-openai", "Travail", "openai-compatible", "https://api.openai.com/v1", "sk-openai-test",
     "gpt-x", 32768, None, None, None, None, None),
    ("c-anthropic", "Longues", "anthropic", "https://api.anthropic.com", "sk-ant-test",
     "aurore-3", 19456, 4096, None, None, None, None),
    ("c-anthropic-unset", "Sans plafond", "anthropic", "https://api.anthropic.com",
     "sk-ant-other", "aurore-3", 19456, None, None, None, None, None),
    # The one whose memory pass reads its service's list and asks for the least reasoning.
    ("c-openrouter", "Routeur", "openai-compatible", OPENROUTER, "sk-or-test", ROUTED_MODEL,
     32768, 1024, None, None, None, None),
)

STORY = (
    ("user", "*I push the crypt door open.* Hello? Is anyone here?"),
    ("assistant", "*A lid scrapes aside.* Who wakes me, {{user}}?"),
    ("user", "My name is Alex. I am a scholar of old houses."),
    ("assistant", "*She sits up slowly.* A scholar. How long have I slept?"),
    ("user", "Three hundred years, if the carvings tell the truth."),
    ("assistant", "*Her eyes narrow.* Then the world has moved on without me."),
)

# What the simulated server answers each call with: a readable answer that ends on "stop".
ANSWERS = {
    "turn": "*She rises from the stone.* Then show me this new world, Alex.",
    "impersonate": "*I offer her my hand.* Come, I will show you.",
    "memory_pass": json.dumps({
        "facts": [{"content": "Alex is a scholar of old houses."},
                  {"content": "Serana slept for three hundred years."}],
        "summary": "Alex woke Serana in her crypt after three centuries."}),
    "card_assistant": json.dumps({
        "name": "Captain Mira", "description": "A pirate captain who hoards sea charts.",
        "personality": "bold, greedy, loyal to her crew", "scenario": "Aboard her ship.",
        "greeting": "*She rolls up a chart.* Ahoy."}),
}
CALLS = tuple(ANSWERS)
TURN_CONTENT = "*I hold out a lantern.* Will you come with me?"
CARD_BRIEF = "A pirate captain who hoards sea charts."

# OpenRouter's list, as the memory pass reads it: its entry accepts "none".
LISTED = {"data": [{"id": ROUTED_MODEL, "name": "Aurore Large", "reasoning": {
    "mandatory": False, "default_enabled": True, "supported_efforts": ["high", "low", "none"]}}]}


def write_seed(conn) -> None:
    """The rows of the five conversations, by SQL, with fixed ids and dates."""
    at = "2026-11-01T10:00:00+00:00"
    conn.execute("INSERT INTO personas (id, name, description, is_default, created_at, updated_at)"
                 " VALUES ('p-alex', 'Alex', 'A wandering scholar.', 1, ?, ?)", (at, at))
    conn.execute(
        "INSERT INTO characters (id, name, description, personality, scenario, greeting,"
        " created_at, updated_at) VALUES ('ch-serana', 'Serana', ?, ?, ?, ?, ?, ?)",
        ("A centuries-old vampire noble with a dry wit.", "wry, guarded, fiercely loyal",
         "{{user}} found her sealed in an ancient crypt.", "*She stirs.* Who are you?", at, at))
    for n, row in enumerate(CONNECTIONS):
        made = f"2026-11-01T10:0{n}:00+00:00"
        conn.execute(
            "INSERT INTO connections (id, name, provider, base_url, api_key, model, context_size,"
            " max_tokens, temperature, top_p, frequency_penalty, presence_penalty, is_default,"
            " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (*row, int(n == 0), made, made))
        conn_id = row[0]
        convo_id = f"x-{conn_id.removeprefix('c-')}"
        conn.execute(
            "INSERT INTO conversations (id, character_id, persona_id, connection_id, title,"
            " created_at, updated_at) VALUES (?, 'ch-serana', 'p-alex', ?, 'The crypt', ?, ?)",
            (convo_id, conn_id, made, made))
        for position, (role, text) in enumerate(STORY):
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, variants, position, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (f"{convo_id}-m{position}", convo_id, role, json.dumps([text]), position,
                 f"2026-11-01T11:0{position}:00+00:00"))


def read_seed(conn) -> dict[str, list[dict]]:
    """The seed's rows as they read once written, every column of them."""
    out = {}
    for table in TABLES:
        cursor = conn.execute(f"SELECT * FROM {table} ORDER BY rowid")
        names = [d[0] for d in cursor.description]
        out[table] = [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]
    return out


def put_seed(conn, seed: dict[str, list[dict]]) -> None:
    """Writes the recorded rows as they are, for the run that compares with them."""
    for table in TABLES:
        for row in seed[table]:
            conn.execute(f"INSERT INTO {table} ({', '.join(row)})"
                         f" VALUES ({', '.join('?' for _ in row)})", tuple(row.values()))


def _sse(events: list[dict], end: str | None = None) -> httpx.Response:
    lines = [f"data: {json.dumps(event)}\n\n" for event in events]
    if end:
        lines.append(f"data: {end}\n\n")
    return httpx.Response(200, content="".join(lines).encode(),
                          headers={"content-type": "text/event-stream"})


class Server:
    """Every model's server at once: it answers ``answer`` to each request for a reply, and keeps
    the body of each, and OpenRouter's list to whoever reads it."""

    def __init__(self):
        self.answer = ""
        self.bodies: list[dict] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and str(request.url).startswith(OPENROUTER):
            assert path.endswith("/models"), path
            return httpx.Response(200, json=LISTED)
        if path.endswith("/messages"):
            self.bodies.append(json.loads(request.content))
            return _sse([
                {"type": "message_start"},
                {"type": "content_block_delta", "delta": {"type": "text_delta",
                                                          "text": self.answer}},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}},
                {"type": "message_stop"}])
        if path.endswith("/chat/completions"):
            self.bodies.append(json.loads(request.content))
            return _sse([{"choices": [{"delta": {"content": self.answer},
                                       "finish_reason": "stop"}]}], end="[DONE]")
        return httpx.Response(404, json={"error": {"message": f"nothing at {path}"}})


@contextmanager
def lent_to_every_provider(server: Server):
    """Each provider made meanwhile reaches ``server`` and nothing else."""
    from app.providers.base import Provider

    made = Provider.__init__

    def init(self, connection):
        made(self, connection)
        self._client_factory = lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(server.handler))

    Provider.__init__ = init
    try:
        yield
    finally:
        Provider.__init__ = made


async def call_each(client: httpx.AsyncClient, server: Server) -> dict[str, dict]:
    """The four calls of each conversation of the seed, on an application whose database holds
    it: for each connection, the body each call sent, and the turn's meta.context."""
    # One connection after another: each call is told by the body it adds.
    return {row[0]: await _calls_of(client, server, row[0]) for row in CONNECTIONS}


async def _calls_of(client: httpx.AsyncClient, server: Server, conn_id: str) -> dict:
    from app import db
    from app.models.schemas import CardAssistRequest
    from app.services import card_assistant, memory_service, turns

    convo_id = f"x-{conn_id.removeprefix('c-')}"

    async def turn():
        resp = await client.post("/api/chat", json={
            "conversation_id": convo_id, "mode": "send", "content": TURN_CONTENT})
        assert resp.status_code == 200, resp.text
        if running := await turns.running_for(convo_id):
            await running.finished.wait()
        outcome = (await client.get(f"/api/conversations/{convo_id}/turn")).json()
        assert outcome["outcome"] is None, outcome

    async def impersonate():
        resp = await client.post(f"/api/conversations/{convo_id}/impersonate")
        assert resp.status_code == 200, resp.text

    async def memory_pass():
        conn = await db.connect()
        try:
            # hold_back=0: with the default, a conversation this short is not read at all.
            result = await memory_service.run_maintenance(conn, convo_id, hold_back=0)
        finally:
            await conn.close()
        assert result["facts_added"], result

    async def card():
        conn = await db.connect()
        try:
            job_id = await card_assistant.start(conn, CardAssistRequest(
                prompt=CARD_BRIEF, connection_id=conn_id))
        finally:
            await conn.close()
        job = card_assistant._jobs[job_id]
        await asyncio.wait_for(job.finished.wait(), 10)
        assert job.error is None and job.draft, (job.error, job.draft)

    calls = {}
    for call, run in zip(CALLS, (turn, impersonate, memory_pass, card), strict=True):
        server.answer = ANSWERS[call]
        sent = len(server.bodies)
        await run()
        if len(server.bodies) != sent + 1:
            raise AssertionError(f"{call} sent {len(server.bodies) - sent} requests, not one")
        calls[call] = server.bodies[-1]
    messages = (await client.get(f"/api/conversations/{convo_id}")).json()["messages"]
    calls["turn_context"] = messages[-1]["meta"]["context"]
    return calls


async def record() -> dict:
    """The seed and every call's body, on the code this runs on, in a folder of its own."""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
        os.environ["EVERMIND_DATA_DIR"] = str(Path(folder) / "data")
        os.environ["EVERMIND_UI_DIR"] = str(Path(folder) / "no-ui")
        os.environ.pop("EVERMIND_GATE_PASSWORD", None)
        import sqlite3

        from app.config import db_path
        from app.db import init_db
        from app.main import create_app

        await init_db()
        conn = sqlite3.connect(db_path())
        try:
            write_seed(conn)
            conn.commit()
            seed = read_seed(conn)
        finally:
            conn.close()

        server = Server()
        app = create_app()
        with lent_to_every_provider(server):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url="http://localhost") as client:
                requests = await call_each(client, server)
        pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        if pending:
            await asyncio.wait(pending, timeout=5)

    missing = [(c, call) for c, calls in requests.items() for call in CALLS if not calls.get(call)]
    if len(requests) * len(CALLS) != 20 or missing:
        raise AssertionError(f"not every call sent a body: {missing}")
    return {"seed": seed, "requests": requests}


def test_the_recorded_requests_are_whole():
    recorded = json.loads(RECORDED.read_text(encoding="utf-8"))
    assert [c["id"] for c in recorded["seed"]["connections"]] == [row[0] for row in CONNECTIONS]
    assert set(recorded["requests"]) == {row[0] for row in CONNECTIONS}
    for conn_id, calls in recorded["requests"].items():
        assert all(calls[call] for call in CALLS), conn_id
        assert calls["turn_context"], conn_id
        # Only OpenRouter's memory pass asks for the least reasoning (3.5.2).
        asked = {call for call in CALLS if "reasoning" in calls[call]}
        assert asked == ({"memory_pass"} if conn_id == "c-openrouter" else set()), conn_id
    assert recorded["requests"]["c-openrouter"]["memory_pass"]["reasoning"] == {"effort": "none"}


if __name__ == "__main__":
    if sys.argv[1:] != ["--record"]:
        sys.exit("usage: python -m tests.test_requests_before --record")
    recorded = asyncio.run(record())
    RECORDED.parent.mkdir(exist_ok=True)  # the release before may have no fixtures folder
    RECORDED.write_text(json.dumps(recorded, indent=1, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    print(f"recorded {RECORDED}")
