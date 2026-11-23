"""A Remember or a Condense outlives the request that asked for it, as a reply does.

The server runs them as tasks of its own: a page that goes away, or a request cancelled, cancels
nothing; what they write is in the memory, and what failed is told by the conversation until an
operation succeeds. Only the server stopping ends them, and then nothing is left half-written.
"""

import asyncio
import json

from app.main import lifespan
from app.providers.base import ProviderError, ProviderEvent
from app.services import memory_service

from .conftest import FakeProvider, send, setup_conversation, waiting_provider, within

FACTS = {"facts": [{"content": f"Fact number {n}.", "kind": "event"} for n in range(1, 10)],
         "summary": "Read to the end."}


def answers(reply: dict) -> list[ProviderEvent]:
    return [ProviderEvent(type="delta", text=json.dumps(reply)), ProviderEvent(type="done")]


async def story(client, monkeypatch) -> str:
    monkeypatch.setattr("app.services.chat_service.get_provider", FakeProvider)
    # The automatic pass would answer for the test's own.
    monkeypatch.setattr("app.services.memory_service.schedule_if_due", lambda convo_id: None)
    FakeProvider.script = [ProviderEvent(type="delta", text="Reply."), ProviderEvent(type="done")]
    convo = await setup_conversation(client)
    await send(client, convo["id"])
    return convo["id"]


async def all_done():
    await within(5, asyncio.gather(*memory_service._tasks, return_exceptions=True))


async def facts_of(client, convo_id) -> list[str]:
    return sorted(m["content"] for m in (await client.get(f"/api/conversations/{convo_id}/memories")).json())


async def test_a_remember_whose_asker_left_goes_on_and_writes_the_memory(client, monkeypatch):
    convo_id = await story(client, monkeypatch)
    started, release, _ = waiting_provider(monkeypatch)
    FakeProvider.script = answers(FACTS)
    url = f"/api/conversations/{convo_id}"

    asking = asyncio.create_task(client.post(f"{url}/memories/extract"))
    await within(5, started.wait())
    during = (await client.get(url)).json()
    asking.cancel()  # the page went, and its request with it
    await asyncio.gather(asking, return_exceptions=True)
    release.set()
    await all_done()

    assert (during["memory_running"], during["memory_operation"]) == (True, "extract")
    after = (await client.get(url)).json()
    assert (after["memory_running"], after["memory_operation"], after["memory_error"]) == (False, None, None)
    assert after["summary"] == "Read to the end."
    assert len(await facts_of(client, convo_id)) == 9


async def test_a_condense_whose_asker_left_goes_on_and_merges(client, monkeypatch):
    convo_id = await story(client, monkeypatch)
    monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
    FakeProvider.script = answers(FACTS)
    assert (await client.post(f"/api/conversations/{convo_id}/memories/extract")).status_code == 200
    started, release, _ = waiting_provider(monkeypatch)
    FakeProvider.script = answers({"facts": [{"content": "All of it, merged."}]})
    url = f"/api/conversations/{convo_id}"

    asking = asyncio.create_task(client.post(f"{url}/memories/consolidate"))
    await within(5, started.wait())
    assert (await client.get(url)).json()["memory_operation"] == "consolidate"
    asking.cancel()
    await asyncio.gather(asking, return_exceptions=True)
    release.set()
    await all_done()

    assert await facts_of(client, convo_id) == ["All of it, merged."]
    assert (await client.get(url)).json()["memory_running"] is False


async def test_the_failure_of_an_operation_whose_asker_left_is_told_until_one_succeeds(client, monkeypatch):
    convo_id = await story(client, monkeypatch)
    started, release, _ = waiting_provider(monkeypatch)
    FakeProvider.script = [ProviderError("http://localhost:1234/v1", "unreachable")]
    url = f"/api/conversations/{convo_id}"

    asking = asyncio.create_task(client.post(f"{url}/memories/extract"))
    await within(5, started.wait())
    asking.cancel()
    await asyncio.gather(asking, return_exceptions=True)
    release.set()
    await all_done()

    assert (await client.get(url)).json()["memory_error"] == {
        "error": "http://localhost:1234/v1", "kind": "unreachable", "operation": "extract"}
    FakeProvider.script = answers(FACTS)
    assert (await client.post(f"{url}/memories/extract")).status_code == 200
    assert (await client.get(url)).json()["memory_error"] is None


async def test_a_page_that_stays_gets_the_same_answers_as_before(client, monkeypatch):
    convo_id = await story(client, monkeypatch)
    monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
    url = f"/api/conversations/{convo_id}"
    FakeProvider.script = [ProviderError("Bad key", "model_auth_refused", 401)]

    failed = await client.post(f"{url}/memories/extract")
    assert (failed.status_code, failed.json()) == (502, {"error": "Bad key", "kind": "model_auth_refused"})

    FakeProvider.script = answers(FACTS)
    done = await client.post(f"{url}/memories/extract")
    assert done.status_code == 200
    assert set(done.json()) == {"facts_added", "summary", "memories"}
    assert len(done.json()["memories"]) == 9
    assert (await client.get(url)).json()["memory_error"] is None


async def test_one_operation_at_a_time_and_a_refusal_is_not_a_failure(client, monkeypatch):
    convo_id = await story(client, monkeypatch)
    started, release, _ = waiting_provider(monkeypatch)
    FakeProvider.script = answers(FACTS)
    url = f"/api/conversations/{convo_id}"

    first = asyncio.create_task(client.post(f"{url}/memories/extract"))
    try:
        await within(5, started.wait())
        for second in ("extract", "consolidate"):
            refused = await client.post(f"{url}/memories/{second}")
            assert (refused.status_code, refused.json()["kind"]) == (409, "memory_busy")
        assert (await client.get(url)).json()["memory_error"] is None
    finally:
        release.set()
    assert (await within(5, first)).status_code == 200


async def test_the_server_stopping_ends_an_operation_and_leaves_nothing_half_written(make_client, monkeypatch):
    monkeypatch.setattr(memory_service, "fill_vectors", lambda: asyncio.sleep(0))
    async with make_client() as client:
        convo_id = await story(client, monkeypatch)
        monkeypatch.setattr("app.services.memory_service.get_provider", FakeProvider)
        FakeProvider.script = answers(FACTS)
        # The pass is stopped in the middle of what it writes: after its first fact.
        writing, never = asyncio.Event(), asyncio.Event()
        add = memory_service.memories_repo.add_with_vector

        async def add_then_wait(*args, **kwargs):
            saved = await add(*args, **kwargs)
            writing.set()
            await never.wait()
            return saved

        monkeypatch.setattr(memory_service.memories_repo, "add_with_vector", add_then_wait)
        url = f"/api/conversations/{convo_id}"
        async with lifespan(None):
            asking = asyncio.create_task(client.post(f"{url}/memories/extract"))
            await within(5, writing.wait())
        # The lifespan has ended: the server stopped, and the operation with it.
        assert memory_service._tasks == set()
        asking.cancel()
        await asyncio.gather(asking, return_exceptions=True)

        after = (await client.get(url)).json()
        assert await facts_of(client, convo_id) == []
        assert after["summary"] == ""
        assert (after["memory_running"], after["memory_error"]) == (False, None)
