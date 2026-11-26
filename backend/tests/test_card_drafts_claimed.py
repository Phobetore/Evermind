"""What the card assistant costs is counted: each draft leaves its row, under the card it was
written for, and a card saved for the first time claims the drafts that wrote it."""

import asyncio

import httpx

from app.db import _connect
from app.repositories import calls as calls_repo
from app.services import calls, card_assistant

from .conftest import within
from .test_calls_capture import held, recorded
from .test_card_assistant import CARD_JSON
from .test_memory_room import writing
from .test_my_ais_api import HOSTED, Model
from .helpers import add_model


async def hosted(client, monkeypatch, *answers) -> dict:
    ai = await add_model(client, base_url=HOSTED, model="aurore", name="Aurore")
    Model(*(answers or (writing(CARD_JSON),))).serve(monkeypatch)
    return ai


async def draft(client, ai: dict, **body) -> str:
    """A draft asked of the assistant, once its job has ended."""
    resp = await client.post("/api/characters/assist",
                             json={"prompt": "A seller of maps", "model_id": ai["id"], **body})
    assert resp.status_code == 202, resp.text
    job_id = resp.json()["id"]
    await within(5, card_assistant._jobs[job_id].finished.wait())
    return job_id


async def save(client, **fields) -> dict:
    resp = await client.post("/api/characters", json={"name": "Nyra", **fields})
    assert resp.status_code == 201, resp.text
    return resp.json()


def card_of(row: dict) -> tuple:
    return row["card_id"], row["card_name"], row["card_kind"]


async def test_a_draft_is_one_card_row_with_its_job(client, monkeypatch):
    ai = await hosted(client, monkeypatch)
    named = await draft(client, ai, existing={"name": "Nyra"})
    blank = await draft(client, ai, kind="scenario")

    first, second = await recorded("card")
    assert (first["job_id"], first["outcome"], first["model_id"]) == (named, "whole", ai["id"])
    assert card_of(first) == (None, "Nyra", "character")
    assert first["conversation_id"] is None and first["tokens_in"] > 0
    # A card with no name yet: the page names it a new card.
    assert (second["job_id"], card_of(second)) == (blank, (None, None, "scenario"))


async def test_a_stopped_draft_is_stopped(client, monkeypatch):
    ai = await hosted(client, monkeypatch, held)
    resp = await client.post("/api/characters/assist",
                             json={"prompt": "A seller of maps", "model_id": ai["id"]})
    job = card_assistant._jobs[resp.json()["id"]]

    async def written():
        while "waits" not in job.text():
            await asyncio.sleep(0.01)

    await within(5, written())
    stopped = await client.delete(f"/api/characters/assist/{job.id}")
    assert stopped.json()["stopped"] is True

    [row] = await recorded("card")
    assert (row["job_id"], row["outcome"], row["tokens_source"]) == (job.id, "stopped", "estimated")
    assert row["tokens_out"] > 0


async def test_a_card_being_edited_names_itself(client, monkeypatch):
    ai = await hosted(client, monkeypatch)
    card = await save(client, kind="scenario")
    await draft(client, ai, card_id=card["id"], kind="scenario", existing={"name": "Nyra"})

    [row] = await recorded("card")
    assert card_of(row) == (card["id"], "Nyra", "scenario")


async def test_the_first_save_claims_its_drafts(client, monkeypatch):
    ai = await hosted(client, monkeypatch)
    jobs = [await draft(client, ai), await draft(client, ai, existing={"name": "Old name"})]
    other = await draft(client, ai)

    card = await save(client, kind="scenario", assist_jobs=jobs)
    assert "assist_jobs" not in card

    found = {row["job_id"]: card_of(row) for row in await recorded("card")}
    assert found[jobs[0]] == found[jobs[1]] == (card["id"], "Nyra", "scenario")
    # A draft the card did not name stays a new card's.
    assert found[other] == (None, None, "character")


async def test_a_claim_never_takes_a_row_that_has_a_card(client, monkeypatch):
    ai = await hosted(client, monkeypatch)
    first = await save(client, name="Serana")
    job = await draft(client, ai, card_id=first["id"], existing={"name": "Serana"})

    second = await save(client, assist_jobs=[job])
    [row] = await recorded("card")
    assert card_of(row) == (first["id"], "Serana", "character")

    db = await _connect()
    try:
        assert await calls_repo.claim(db, [job], second["id"], "Nyra", "character") == 0
        assert await calls_repo.claim(db, [], second["id"], "Nyra", "character") == 0
    finally:
        await db.close()


async def test_too_many_jobs_are_refused(client):
    jobs = [f"job-{n}" for n in range(51)]
    resp = await client.post("/api/characters", json={"name": "Nyra", "assist_jobs": jobs})
    assert resp.status_code == 422
    assert (await client.get("/api/characters")).json() == []

    for bad in ([""], ["x" * 65]):
        resp = await client.post("/api/characters", json={"name": "Nyra", "assist_jobs": bad})
        assert resp.status_code == 422
    assert (await save(client, assist_jobs=jobs[:50]))["name"] == "Nyra"


async def test_a_draft_stopped_before_its_request_went_costs_nothing(client, monkeypatch):
    ai = await hosted(client, monkeypatch)
    model = Model(writing(CARD_JSON))
    monkeypatch.setattr("app.services.card_assistant.get_provider", model.provider)
    inserting, release = asyncio.Event(), asyncio.Event()
    write = calls._write

    async def held_insert(sql, params):
        if sql.startswith("INSERT"):
            inserting.set()
            await release.wait()
        await write(sql, params)

    monkeypatch.setattr(calls, "_write", held_insert)
    resp = await client.post("/api/characters/assist",
                             json={"prompt": "A seller of maps", "model_id": ai["id"]})
    job_id = resp.json()["id"]
    await within(5, inserting.wait())
    stopping = asyncio.create_task(client.delete(f"/api/characters/assist/{job_id}"))
    while not card_assistant._jobs[job_id].stopped:
        await asyncio.sleep(0.01)
    release.set()
    assert (await within(5, stopping)).json()["stopped"] is True

    assert model.bodies == []
    [row] = await recorded("card")
    assert (row["outcome"], row["tokens_in"], row["cost"]) == ("refused", 0, 0)


async def test_a_refused_draft_is_one_refused_row_that_costs_nothing(client, monkeypatch):
    ai = await hosted(client, monkeypatch, (429, {"error": {"message": "Slow down."}}))
    await draft(client, ai)

    [row] = await recorded("card")
    assert (row["outcome"], row["status"], row["tokens_in"], row["cost"]) == ("refused", 429, 0, 0)


async def test_a_draft_on_a_server_out_of_reach_is_refused_with_no_status(client, monkeypatch):
    def unreachable():
        raise httpx.ConnectError("nobody there")

    ai = await hosted(client, monkeypatch, unreachable)
    await draft(client, ai)

    [row] = await recorded("card")
    assert (row["outcome"], row["status"], row["tokens_in"], row["cost"]) == ("refused", None, 0, 0)


async def test_a_draft_answered_with_spaces_is_empty(client, monkeypatch):
    ai = await hosted(client, monkeypatch, writing("   "))
    await draft(client, ai)

    [row] = await recorded("card")
    assert row["outcome"] == "empty"


async def test_a_card_id_out_of_bounds_is_refused(client, monkeypatch):
    ai = await hosted(client, monkeypatch)
    for bad in ("", "x" * 65):
        resp = await client.post("/api/characters/assist", json={
            "prompt": "A seller of maps", "model_id": ai["id"], "card_id": bad})
        assert resp.status_code == 422, resp.text
    assert card_assistant._jobs == {}
    assert await recorded() == []

