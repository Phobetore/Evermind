"""The update that splits connections into services and their AIs: no row lost, every conversation
answered by the model that answers it today, and a database the release before still runs on."""

import shutil
import sqlite3

import pytest

from app import __version__, db
from app.config import db_path

MIGRATION = "021_my_ais.sql"
REAL_MIGRATIONS = db.MIGRATIONS_DIR

OLLAMA = "http://localhost:11434/v1"
LMSTUDIO = "http://localhost:1234/v1"
OPENAI = "https://api.openai.com/v1"
ANTHROPIC = "https://api.anthropic.com"
OPENROUTER = "https://openrouter.ai/api/v1"
LAN = "http://192.168.1.20:8000/v1"
GROQ = "https://api.groq.com/openai/v1"
MISTRAL = "https://api.mistral.ai/v1"


@pytest.fixture()
def start(tmp_path, monkeypatch):
    """Starts on the migrations that come before this update, then again with ``files`` added:
    the names of real migrations, or {name: sql} for one written by the test."""
    folder = tmp_path / "migrations"
    folder.mkdir()
    for path in REAL_MIGRATIONS.glob("*.sql"):
        if path.name < MIGRATION:
            shutil.copy(path, folder / path.name)
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", folder)

    async def start(*files):
        for item in files:
            if isinstance(item, dict):
                for name, sql in item.items():
                    (folder / name).write_text(sql, encoding="utf-8")
            else:
                shutil.copy(REAL_MIGRATIONS / item, folder / item)
        await db.init_db()

    start.folder = folder
    return start


def run(sql: str, params=(), keys: bool = False) -> None:
    conn = sqlite3.connect(db_path())
    try:
        if keys:
            conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def rows(sql: str, params=()) -> list[dict]:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def by_id(table: str) -> dict[str, dict]:
    return {r["id"]: r for r in rows(f"SELECT * FROM {table} ORDER BY rowid")}


def everything() -> dict:
    """Every table and every row of the database, to tell whether anything moved."""
    conn = sqlite3.connect(db_path())
    try:
        tables = conn.execute(
            "SELECT type, name, sql FROM sqlite_master ORDER BY type, name").fetchall()
        return {"schema": tables, **{
            name: conn.execute(f"SELECT * FROM {name} ORDER BY rowid").fetchall()
            for kind, name, _ in tables if kind == "table"}}
    finally:
        conn.close()


_clock = iter(range(1, 1000))


def connection(conn_id: str, name: str, base_url: str, model: str = "", *,
               provider: str = "openai-compatible", api_key: str = "", context_size: int = 8192,
               max_tokens: int | None = None, temperature: float | None = None,
               top_p: float | None = None, frequency_penalty: float | None = None,
               presence_penalty: float | None = None, is_default: int = 0) -> None:
    """A connection as the release before wrote it, each one newer than the last."""
    at = f"2026-01-01T00:{next(_clock):04d}"
    run("INSERT INTO connections (id, name, provider, base_url, api_key, model, context_size,"
        " max_tokens, temperature, top_p, frequency_penalty, presence_penalty, is_default,"
        " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (conn_id, name, provider, base_url, api_key, model, context_size, max_tokens,
         temperature, top_p, frequency_penalty, presence_penalty, is_default, at, at))


def character() -> None:
    run("INSERT INTO characters (id, name, created_at, updated_at)"
        " VALUES ('serana', 'Serana', '2026-01-01', '2026-01-01')")


def conversation(convo_id: str, connection_id: str | None) -> None:
    run("INSERT INTO conversations (id, character_id, connection_id, created_at, updated_at)"
        " VALUES (?, 'serana', ?, '2026-01-02', '2026-01-02')", (convo_id, connection_id))


def ai_of(before: dict, **changed) -> dict:
    """The AI a connection becomes, its values as they were."""
    return {
        "id": before["id"], "connection_id": before["id"], "model": before["model"],
        "name": before["name"], "is_default": before["is_default"],
        "context_own": before["context_size"], "context_read": None, "context_read_kind": None,
        "output_read": None, "reasons": None, "price_in": None, "price_out": None,
        "price_cache_read": None, "price_cache_write": None, "price_varies": 0,
        "price_own_in": None, "price_own_out": None, "limits_read_at": None,
        "reply_cap_mode": "fixed", "reply_cap_tokens": before["max_tokens"],
        "temperature": before["temperature"], "top_p": before["top_p"],
        "frequency_penalty": before["frequency_penalty"],
        "presence_penalty": before["presence_penalty"],
        "token_ratio": None, "token_ratio_n": 0, "fit_margin": None, "reply_tokens_avg": None,
        "migrated": 1, "notices_kept": 0,
        "created_at": before["created_at"], "updated_at": before["updated_at"], **changed}


def service_of(before: dict, **changed) -> dict:
    return {**before, "family_url": before["base_url"].rstrip("/"), **changed}


async def test_every_connection_becomes_an_ai_with_its_id_and_its_values(start):
    await start()
    connection("c1", "Brume", OLLAMA, "brume:12b", context_size=16384, max_tokens=1024,
               temperature=0.8, top_p=0.95, frequency_penalty=0.15, presence_penalty=0.15,
               is_default=1)
    connection("c2", "Travail", OPENAI, "gpt-x", context_size=32768, api_key="sk-openai")
    connection("c3", "Longues", ANTHROPIC, "aurore-3", provider="anthropic", api_key="sk-ant",
               context_size=19456, max_tokens=4096)
    before = by_id("connections")

    await start(MIGRATION)

    assert by_id("models") == {
        "c1": ai_of(before["c1"]),
        "c2": ai_of(before["c2"], reply_cap_mode="unsent"),
        "c3": ai_of(before["c3"]),
    }
    assert by_id("connections") == {
        "c1": service_of(before["c1"], family="ollama", name="Ollama"),
        "c2": service_of(before["c2"], family="openai", name="OpenAI"),
        "c3": service_of(before["c3"], family="anthropic", name="Anthropic"),
    }


async def test_an_empty_ceiling_is_unsent_even_on_anthropic_and_a_zero_one_too(start):
    await start()
    connection("c1", "Longues", ANTHROPIC, "aurore-3", provider="anthropic", api_key="sk-ant",
               context_size=19456)
    connection("c2", "Brume", OLLAMA, "brume:12b", max_tokens=0)
    before = by_id("connections")

    await start(MIGRATION)

    assert by_id("models") == {
        "c1": ai_of(before["c1"], reply_cap_mode="unsent"),
        "c2": ai_of(before["c2"], reply_cap_mode="unsent", reply_cap_tokens=None),
    }


async def test_two_connections_on_one_server_with_one_key_share_one_service(start):
    await start()
    connection("c1", "Aurore", OPENROUTER, "aurore/aurore-large", api_key="sk-or-1",
               max_tokens=1024)
    connection("c2", "Sylve", OPENROUTER + "/", "sylve/sylve-2.5", api_key="sk-or-1",
               max_tokens=2048)
    before = by_id("connections")

    await start(MIGRATION)

    assert by_id("connections") == {
        "c1": service_of(before["c1"], family="openrouter", name="OpenRouter")}
    assert by_id("connections")["c1"]["family_url"] == "https://openrouter.ai/api/v1"
    assert by_id("models") == {"c1": ai_of(before["c1"]),
                               "c2": ai_of(before["c2"], connection_id="c1")}
    assert rows("SELECT COUNT(*) AS n FROM connections WHERE api_key = ?", ("sk-or-1",)) == [
        {"n": 1}]


async def test_two_keys_on_one_server_make_two_services_with_distinct_names(start):
    await start()
    connection("c1", "Aurore", OPENROUTER, "aurore/aurore-large", api_key="sk-or-1")
    connection("c2", "Sylve", OPENROUTER, "sylve/sylve-2.5", api_key="sk-or-2")
    before = by_id("connections")

    await start(MIGRATION)

    assert by_id("connections") == {
        "c1": service_of(before["c1"], family="openrouter", name="OpenRouter"),
        "c2": service_of(before["c2"], family="openrouter", name="OpenRouter (2)"),
    }
    assert {i: m["connection_id"] for i, m in by_id("models").items()} == {"c1": "c1", "c2": "c2"}


async def test_ais_that_would_share_a_name_are_told_apart(start):
    await start()
    connection("a1", "OpenRouter", OPENROUTER, "aurore/aurore-large", api_key="sk-or-1")
    connection("a2", "OpenRouter", OPENROUTER, "sylve/sylve-2.5", api_key="sk-or-1")
    connection("b1", "Brume", LMSTUDIO, "brume-12b")
    connection("b2", "Brume", LMSTUDIO, "brume-12b")
    connection("p", "PC du salon", LAN, "salon-8b")
    connection("m", "Mon OR", OPENROUTER, "nuit/nuit-7b", api_key="sk-or-1")
    connection("k2", "OpenRouter", OPENROUTER, "vent/vent-mini", api_key="sk-or-2")
    connection("e", "OpenRouter", OPENROUTER, "", api_key="sk-or-1")
    connection("late", "aurore-large", OPENROUTER, "q/aurore-large", api_key="sk-or-4")
    # Ids the API before took as typed: one ends in "/", one is nothing but it.
    connection("g", "Groq", GROQ, "weird/", api_key="gsk-1")
    connection("s", "Mistral", MISTRAL, "/", api_key="ms-1")
    before = by_id("connections")

    await start(MIGRATION)

    names = {"a1": "aurore-large (2)", "a2": "sylve-2.5", "b1": "brume-12b",
             "b2": "brume-12b (2)", "p": "PC du salon", "m": "Mon OR", "k2": "vent-mini",
             "e": "OpenRouter", "late": "aurore-large", "g": "weird", "s": "Mistral"}
    held_by = {"a1": "a1", "a2": "a1", "b1": "b1", "b2": "b1", "p": "p", "m": "a1", "k2": "k2",
               "e": "a1", "late": "late", "g": "g", "s": "s"}
    assert by_id("models") == {
        i: ai_of(before[i], name=names[i], connection_id=held_by[i], reply_cap_mode="unsent")
        for i in before}
    assert {i: (c["name"], c["family"]) for i, c in by_id("connections").items()} == {
        "a1": ("OpenRouter", "openrouter"), "b1": ("LM Studio", "lmstudio"),
        "p": ("PC du salon", "generic"), "k2": ("OpenRouter (2)", "openrouter"),
        "late": ("OpenRouter (3)", "openrouter"), "g": ("Groq", "groq"),
        "s": ("Mistral", "mistral")}


async def test_an_ai_alone_under_its_chip_s_name_takes_its_model_s(start):
    await start()
    connection("mine", "Mon OR", OPENROUTER, "aurore/aurore-large", api_key="sk-or-1")
    connection("lone", "OpenRouter", OPENROUTER, "nuit/nuit-7b", api_key="sk-or-2")

    await start(MIGRATION)

    # Compared with the chip's label before its service became "OpenRouter (2)".
    assert {i: m["name"] for i, m in by_id("models").items()} == {
        "mine": "Mon OR", "lone": "nuit-7b"}
    assert {i: c["name"] for i, c in by_id("connections").items()} == {
        "mine": "OpenRouter", "lone": "OpenRouter (2)"}


async def test_a_known_address_or_api_names_its_service(start):
    await start()
    table = [  # id, address, API, key, then the service it makes: holder, family, name
        ("ol", OLLAMA + "/", "openai-compatible", "", "ol", "ollama", "Ollama"),
        ("lm", LMSTUDIO, "openai-compatible", "", "lm", "lmstudio", "LM Studio"),
        ("cpp", "http://localhost:8080/v1/", "openai-compatible", "", "cpp", "llamacpp",
         "llama.cpp"),
        ("kob", "http://localhost:5001/v1", "openai-compatible", "", "kob", "koboldcpp",
         "KoboldCpp"),
        ("oa", OPENAI, "openai-compatible", "sk-oa", "oa", "openai", "OpenAI"),
        ("or", OPENROUTER, "openai-compatible", "sk-or", "or", "openrouter", "OpenRouter"),
        ("gq", GROQ, "openai-compatible", "gsk", "gq", "groq", "Groq"),
        # The oldest of a group holds the service with the "/" it was typed with.
        ("mi", MISTRAL + "/", "openai-compatible", "ms", "mi", "mistral", "Mistral"),
        ("mi2", MISTRAL, "openai-compatible", "ms", "mi", "mistral", "Mistral"),
        # One server and key under two APIs are two services.
        ("an", ANTHROPIC, "anthropic", "sk-ant", "an", "anthropic", "Anthropic"),
        ("an-oc", ANTHROPIC, "openai-compatible", "sk-ant", "an-oc", "anthropic",
         "Anthropic (2)"),
        ("an-lan", "http://192.168.1.21:9000", "anthropic", "", "an-lan", "anthropic",
         "Anthropic (3)"),
        ("lan", LAN, "openai-compatible", "", "lan", "generic", "Mine lan"),
    ]
    for conn_id, url, provider, key, *_ in table:
        connection(conn_id, f"Mine {conn_id}", url, f"m-{conn_id}", provider=provider,
                   api_key=key)
    urls = {conn_id: url for conn_id, url, *_ in table}

    await start(MIGRATION)

    assert {i: m["connection_id"] for i, m in by_id("models").items()} == {
        conn_id: holder for conn_id, _, _, _, holder, *_ in table}
    assert {i: (c["family"], c["name"], c["family_url"])
            for i, c in by_id("connections").items()} == {
        holder: (family, name, urls[holder].rstrip("/"))
        for _, _, _, _, holder, family, name in table}


async def test_a_hand_written_window_sends_what_it_sent(start):
    await start()
    connection("c1", "Brume", OLLAMA, "brume:12b", context_size=0)
    connection("c2", "Sylve", LMSTUDIO, "sylve-7b", context_size=300)
    connection("c3", "Nuit", LAN, "nuit-7b", context_size=512)
    before = by_id("connections")

    await start(MIGRATION)

    assert by_id("models") == {
        "c1": ai_of(before["c1"], context_own=8192, reply_cap_mode="unsent"),
        "c2": ai_of(before["c2"], context_own=512, reply_cap_mode="unsent"),
        "c3": ai_of(before["c3"], context_own=512, reply_cap_mode="unsent"),
    }


async def test_an_unknown_address_keeps_its_name_and_is_generic(start):
    await start()
    connection("c1", "PC du salon", LAN, "salon-8b")
    before = by_id("connections")

    await start(MIGRATION)

    assert by_id("connections") == {"c1": service_of(before["c1"], family="generic")}
    assert by_id("models") == {"c1": ai_of(before["c1"], reply_cap_mode="unsent")}


# The release before's choice of connection for a conversation, as written in
# backend/app/repositories/connections.py:53-58 at the base (_DEFAULT_FIRST from line 8).
RESOLVE_BEFORE = ("SELECT * FROM connections ORDER BY id IS ? DESC, "
                  "is_default DESC, created_at, rowid LIMIT 1")


async def test_every_conversation_keeps_the_model_that_answers_it_today(start):
    await start()
    character()
    connection("old", "Aurore", OPENROUTER, "aurore/aurore-large", api_key="sk-or-1")
    connection("marked", "Brume", OLLAMA, "brume:12b", is_default=1)
    connection("merged", "Sylve", OPENROUTER, "sylve/sylve-2.5", api_key="sk-or-1")
    conversation("to-marked", "marked")
    conversation("to-merged", "merged")
    conversation("to-none", None)
    conversation("to-gone", "gone")  # written with the keys off, as a hand-edited base could be
    answering = {c["id"]: rows(RESOLVE_BEFORE, (c["connection_id"],))[0]["id"]
                 for c in rows("SELECT * FROM conversations")}
    assert answering == {"to-marked": "marked", "to-merged": "merged", "to-none": "marked",
                         "to-gone": "marked"}
    before = by_id("conversations")

    await start(MIGRATION)

    assert by_id("conversations") == {
        i: {**c, "model_id": answering[i], "model_lost": None,
            "connection_id": c["connection_id"] if c["connection_id"] == "marked" else None}
        for i, c in before.items()}


async def test_a_base_without_connections_migrates_and_conversations_have_no_ai(start):
    await start()
    character()
    conversation("alone", None)

    await start(MIGRATION)

    assert rows("SELECT * FROM models") == []
    assert [(c["id"], c["model_id"]) for c in rows("SELECT * FROM conversations")] == [
        ("alone", None)]


async def test_a_failure_half_way_leaves_the_database_as_it_was(start):
    await start()
    character()
    connection("c1", "Aurore", OPENROUTER, "aurore/aurore-large", api_key="sk-or-1")
    connection("c2", "Sylve", OPENROUTER, "sylve/sylve-2.5", api_key="sk-or-1")
    conversation("x", "c2")
    before = everything()

    with pytest.raises(sqlite3.IntegrityError):
        await start(MIGRATION, {
            "022_fails.sql": "INSERT INTO schema_migrations (name) VALUES ('001_init.sql');"})

    assert everything() == before
    assert "models" not in before
    assert (MIGRATION,) not in before["schema_migrations"]

    (start.folder / "022_fails.sql").unlink()
    await start()

    assert set(by_id("models")) == {"c1", "c2"}
    assert set(by_id("connections")) == {"c1"}


def keyed_rows(sql: str, params=()) -> list[dict]:
    """A read made with the keys on, as the release before reads."""
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


# The release before's writes, as written at the base:
# backend/app/repositories/conversations.py:33-38, a new conversation.
CREATE_CONVERSATION_BEFORE = (
    "INSERT INTO conversations (id, character_id, persona_id, connection_id, title, summary,"
    " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
# backend/app/repositories/conversations.py:256-266, a conversation copied into a branch.
BRANCH_BEFORE = (
    "INSERT INTO conversations (id, character_id, persona_id, connection_id, title,"
    " summary, author_note, memory_position, forked_from, wallpaper_path,"
    " wallpaper_opacity, backdrop, backdrop_strength, created_at, updated_at)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
# backend/app/repositories/connections.py:86, a connection deleted.
DELETE_CONNECTION_BEFORE = "DELETE FROM connections WHERE id = ?"
# backend/app/repositories/connections.py:33-37, a connection added (_FIELDS from lines 5-6).
CREATE_CONNECTION_BEFORE = (
    "INSERT INTO connections (id, name, provider, base_url, model, context_size, max_tokens,"
    " temperature, top_p, frequency_penalty, presence_penalty, api_key, is_default,"
    " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
# backend/app/repositories/connections.py:75-80, a connection saved from its form (_FIELDS from lines 5-6).
UPDATE_CONNECTION_BEFORE = (
    "UPDATE connections SET name = ?, provider = ?, base_url = ?, model = ?, context_size = ?,"
    " max_tokens = ?, temperature = ?, top_p = ?, frequency_penalty = ?, presence_penalty = ?,"
    " api_key = COALESCE(?, api_key), is_default = ?, updated_at = ? WHERE id = ?")
# backend/app/repositories/conversations.py:115-133, a conversation given another connection.
CHANGE_CONNECTION_BEFORE = (
    "UPDATE conversations SET connection_id = ?, updated_at = ? WHERE id = ?")


def branch(source: dict, branch_id: str) -> None:
    run(BRANCH_BEFORE, (
        branch_id, source["character_id"], source["persona_id"], source["connection_id"],
        source["title"], source["summary"], source["author_note"] or "",
        source["memory_position"], source["id"], source["wallpaper_path"],
        source["wallpaper_opacity"], source["backdrop"], source["backdrop_strength"],
        "2026-02-01", "2026-02-01"), keys=True)


def save_connection(old: dict, **changed) -> None:
    """The release before's form saved on a connection, with ``changed`` typed in it."""
    c = {**old, **changed}
    run(UPDATE_CONNECTION_BEFORE, (
        c["name"], c["provider"], c["base_url"], c["model"], c["context_size"], c["max_tokens"],
        c["temperature"], c["top_p"], c["frequency_penalty"], c["presence_penalty"], None,
        c["is_default"], "2026-02-01", c["id"]), keys=True)


async def test_the_release_before_still_reads_and_writes_what_it_needs(start):
    await start()
    character()
    connection("c1", "Aurore", OPENROUTER, "aurore/aurore-large", api_key="sk-or-1",
               context_size=32768, max_tokens=1024)
    connection("c2", "Sylve", OPENROUTER, "sylve/sylve-2.5", api_key="sk-or-1",
               context_size=16384, max_tokens=2048)
    connection("c3", "Brume", OLLAMA, "brume:12b", context_size=16384, max_tokens=512,
               is_default=1)
    for convo_id, conn_id in (("x1", "c1"), ("x2", "c2"), ("x3", "c3"), ("x4", None)):
        conversation(convo_id, conn_id)
    before = by_id("connections")

    await start(MIGRATION)

    kept = keyed_rows(RESOLVE_BEFORE, ("c1",))[0]
    assert {k: kept[k] for k in ("id", "model", "context_size", "max_tokens", "api_key")} == {
        k: before["c1"][k] for k in ("id", "model", "context_size", "max_tokens", "api_key")}
    # The merged connection is gone: its conversations get the release before's default.
    assert keyed_rows(RESOLVE_BEFORE, ("c2",))[0]["id"] == "c3"

    run(CREATE_CONVERSATION_BEFORE,
        ("new", "serana", None, None, "", "", "2026-02-01", "2026-02-01"), keys=True)
    for source in rows("SELECT * FROM conversations ORDER BY rowid"):
        branch(source, f"branch-of-{source['id']}")
    assert len(rows("SELECT * FROM conversations")) == 10

    services, ais = everything()["connections"], everything()["models"]
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        run(DELETE_CONNECTION_BEFORE, ("c1",), keys=True)
    assert everything()["connections"] == services
    assert everything()["models"] == ais

    run(CREATE_CONNECTION_BEFORE, (
        "bare", "Spare", "openai-compatible", LAN, "", 8192, None, None, None, None, None,
        "", 0, "2026-02-01", "2026-02-01"), keys=True)
    run(DELETE_CONNECTION_BEFORE, ("bare",), keys=True)
    assert "bare" not in by_id("connections")


async def test_the_release_before_answers_on_the_default_s_service_when_it_was_merged(start):
    await start()
    connection("lm", "Brume", LMSTUDIO, "brume-12b")
    connection("or1", "Aurore", OPENROUTER, "aurore/aurore-large", api_key="sk-or-1")
    connection("or2", "Sylve", OPENROUTER, "sylve/sylve-2.5", api_key="sk-or-1", is_default=1)

    await start(MIGRATION)

    assert [m["id"] for m in rows("SELECT * FROM models WHERE is_default = 1")] == ["or2"]
    # The release before answers a conversation that names no connection with the one that now
    # holds the default AI's service, not with the oldest connection left.
    assert keyed_rows(RESOLVE_BEFORE, (None,))[0]["id"] == "or1"
    assert [c["id"] for c in rows("SELECT * FROM connections WHERE is_default = 1")] == ["or1"]


async def test_coming_back_from_the_release_before_shows_what_it_made(start):
    await start()
    character()
    connection("c1", "Aurore", OPENROUTER, "aurore/aurore-large", api_key="sk-or-1",
               context_size=32768, max_tokens=1024)
    connection("c2", "Brume", LMSTUDIO, "brume-12b", context_size=16384, max_tokens=512)
    conversation("x1", "c1")
    conversation("x2", "c2")

    await start(MIGRATION)

    # What the release before writes, run on the migrated database:
    old = by_id("connections")
    run(CREATE_CONNECTION_BEFORE, (
        "fresh", "Groq", "openai-compatible", "https://api.groq.com/openai/v1", "llama-x",
        8192, 1024, None, None, None, None, "gsk-SECRET", 0, "2026-02-01", "2026-02-01"),
        keys=True)
    run(CREATE_CONVERSATION_BEFORE,
        ("x3", "serana", None, "fresh", "", "", "2026-02-01", "2026-02-01"), keys=True)
    save_connection(old["c1"], max_tokens=4096)
    save_connection(old["c2"], base_url="http://192.168.1.30:1234/v1")
    run(CHANGE_CONNECTION_BEFORE, ("c2", "2026-02-01", "x1"), keys=True)

    # Read back as this release reads:
    services = by_id("connections")
    ais = by_id("models")
    conversations = by_id("conversations")
    assert services["fresh"]["api_key"] == "gsk-SECRET"
    assert services["fresh"]["family"] == "generic"
    assert [a for a in ais.values() if a["connection_id"] == "fresh"] == []
    assert conversations["x3"]["model_id"] is None
    assert (ais["c1"]["reply_cap_mode"], ais["c1"]["reply_cap_tokens"]) == ("fixed", 1024)
    assert {services[a["connection_id"]]["base_url"] for a in ais.values()
            if a["connection_id"] == "c2"} == {"http://192.168.1.30:1234/v1"}
    # The address the family was decided at stays, which is how a changed one is told.
    assert services["c2"]["family_url"] == LMSTUDIO
    assert conversations["x1"]["model_id"] == "c1"


async def test_a_copy_made_before_the_update_migrates_when_put_back(start):
    await start()
    character()
    connection("c1", "Aurore", OPENROUTER, "aurore/aurore-large", api_key="sk-or-1")
    connection("c2", "OpenRouter", OPENROUTER, "sylve/sylve-2.5", api_key="sk-or-1")
    conversation("x", "c2")

    await start(MIGRATION)
    migrated = everything()

    copy = db_path().with_name(f"evermind.before-{__version__}.db")
    for leftover in db_path().parent.glob("evermind.db*"):
        leftover.unlink()
    shutil.copy(copy, db_path())
    assert "models" not in everything()

    await start()

    assert everything() == migrated
