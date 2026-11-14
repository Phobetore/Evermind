"""Card assistant tests (mocked provider): a card is written on a job the server owns."""

import asyncio
import json
import logging
import re

import pytest

from app.prompting.defaults import CARD_ASSISTANT_PROMPT
from app.prompting.tokens import estimate_tokens
from app.providers.base import ProviderError, ProviderEvent
from app.services import card_assistant

from .conftest import FakeProvider, assist, within

CARD = {
    "name": "Nyra",
    "tagline": "La cartographe des futurs.",
    "description": "She draws prophetic cards for {{user}}.",
    "personality": "mischievous, enigmatic",
    "scenario": "{{user}} enters the shop.",
    "greeting": "*She looks up.* Well, {{user}}.",
    "alternate_greetings": ["*The shop is empty.*"],
    "example_dialogues": "<START>\n{{user}}: Fiable ?\n{{char}}: Autant que toi.",
    "tags": ["Fantasy", "Mystery"],
}
CARD_JSON = json.dumps(CARD)

LORE = [{"keys": ["Kabukicho"], "content": "The red-light district."},
        {"keys": ["docks"], "content": "Where the clan sells salt."},
        {"keys": ["ledger"], "content": "A book of debts."},
        {"keys": ["Mei"], "content": "Kenji's sister."}]


@pytest.fixture()
def fake_provider(monkeypatch):
    FakeProvider.script = [ProviderEvent(type="delta", text=CARD_JSON), ProviderEvent(type="done")]
    FakeProvider.captured = {}
    monkeypatch.setattr("app.services.card_assistant.get_provider", FakeProvider)
    return FakeProvider


class Paced(FakeProvider):
    """Gives each event when the test hands it over, and notes when the request to it is closed."""

    queue: asyncio.Queue
    given = 0
    closed = False

    async def stream_chat(self, payload):
        FakeProvider.captured["connection"] = self.connection
        try:
            while (event := await Paced.queue.get()) is not None:
                if isinstance(event, Exception):
                    raise event
                yield event
                Paced.given += 1  # the job has read it once it asks for the next one
        finally:
            Paced.closed = True


@pytest.fixture()
def paced(monkeypatch):
    Paced.queue, Paced.given, Paced.closed = asyncio.Queue(), 0, False
    monkeypatch.setattr("app.services.card_assistant.get_provider", Paced)

    async def give(*events):
        """None ends the answer, and an error breaks it: neither is read as an event."""
        target = Paced.given + sum(isinstance(e, ProviderEvent) for e in events)
        for event in events:
            Paced.queue.put_nowait(event)

        async def read():
            while Paced.given < target:
                await asyncio.sleep(0)

        await within(1, read())

    return give


@pytest.fixture()
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr("app.services.card_assistant._now", lambda: now[0])
    return now


async def add_connection(client, **fields):
    return (await client.post("/api/connections", json={
        "name": "Mock", "provider": "openai-compatible",
        "base_url": "http://localhost:1234/v1", "model": "test", **fields,
    })).json()


async def begin(client, **body) -> str:
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate", **body})
    assert resp.status_code == 202, resp.text
    return resp.json()["id"]


async def state_of(client, job_id) -> dict:
    resp = await client.get(f"/api/characters/assist/{job_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def ended(client, job_id) -> dict:
    await within(2, card_assistant._jobs[job_id].finished.wait())
    return await state_of(client, job_id)


async def test_starting_answers_at_once_with_an_id_and_the_card_arrives_in_the_state(
        client, fake_provider):
    await add_connection(client)
    resp = await client.post("/api/characters/assist", json={
        "prompt": "A mysterious cartographer who sells prophetic cards",
    })
    assert resp.status_code == 202, resp.text
    assert re.fullmatch(r"[0-9a-f]{32}", resp.json()["id"])

    state = await ended(client, resp.json()["id"])
    draft = state.pop("draft")
    assert draft["name"] == "Nyra"
    assert draft["tags"] == ["fantasy", "mystery"]  # lowercased
    assert draft["alternate_greetings"] == ["*The shop is empty.*"]
    assert state == {
        "id": resp.json()["id"], "running": False, "seconds": state["seconds"], "thought": 0,
        "written": len(CARD_JSON), "fields": list(CARD), "lore": 0, "writing": None,
        "missing": ["lore_entries"], "cut": False, "stopped": False, "error": None,
    }
    payload = fake_provider.captured["payload"]
    assert "card-writer" in payload.system
    assert "CHARACTER" in payload.messages[0]["content"]


async def test_the_state_while_the_model_writes_names_what_is_done_and_what_is_being_written(
        client, paced, clock):
    await add_connection(client)
    job_id = await begin(client)
    answer = json.dumps({"name": "Kenji", "tagline": "Never laughs.", "lore_entries": LORE,
                         "tags": ["noir"]})
    cut = answer.index('{"keys": ["Mei"]') + 5

    await paced(ProviderEvent(type="thought", count=300), ProviderEvent(type="delta", text=answer[:cut]))
    clock[0] += 12.34
    state = await state_of(client, job_id)
    assert state == {
        "id": job_id, "running": True, "seconds": 12.3, "thought": 300, "written": cut,
        "fields": ["name", "tagline"], "lore": 3, "writing": "lore_entries",
        "draft": None, "missing": [], "cut": False, "stopped": False, "error": None,
    }

    await paced(ProviderEvent(type="delta", text=answer[cut:-1]), None)
    clock[0] += 5
    state = await ended(client, job_id)
    assert (state["fields"], state["lore"], state["writing"]) == (
        ["name", "tagline", "lore_entries", "tags"], 4, None)
    assert state["draft"]["lore_entries"] == LORE
    assert state["seconds"] == 17.3
    clock[0] += 60
    assert (await state_of(client, job_id))["seconds"] == 17.3, "it stops counting when it ends"


async def test_a_card_cut_short_gives_its_complete_fields_and_says_what_is_missing(
        client, fake_provider):
    await add_connection(client)
    answer = CARD_JSON[:CARD_JSON.index('"alternate_greetings"') + 30]
    fake_provider.script = [ProviderEvent(type="delta", text=answer),
                            ProviderEvent(type="done", stop="length")]
    state = await assist(client)
    assert state["draft"] == {k: CARD[k] for k in
                              ("name", "tagline", "description", "personality", "scenario",
                               "greeting")}
    assert state["missing"] == ["alternate_greetings", "example_dialogues", "tags", "lore_entries"]
    assert (state["cut"], state["error"], state["writing"]) == (True, None, "alternate_greetings")


async def test_an_answer_that_breaks_off_midway_gives_the_draft_and_the_error(
        client, fake_provider):
    await add_connection(client)
    fake_provider.script = [ProviderEvent(type="delta", text=CARD_JSON[:100]),
                            ProviderError("The connection broke.", "model_connection_lost")]
    state = await assist(client)
    assert state["draft"] == {"name": "Nyra", "tagline": CARD["tagline"]}
    assert state["error"] == {"error": "The connection broke.", "kind": "model_connection_lost"}
    assert state["cut"] is False


async def test_reasoning_with_no_answer_is_a_model_that_only_thought(client, fake_provider):
    await add_connection(client)
    fake_provider.script = [ProviderEvent(type="thought", count=5000),
                            ProviderEvent(type="done", stop="length")]
    state = await assist(client)
    assert state["error"]["kind"] == "model_only_thought"
    assert (state["draft"], state["thought"], state["written"], state["cut"]) == (
        None, 5000, 0, True)


async def test_assist_scenario_kind_and_existing_preserved(client, fake_provider):
    await add_connection(client)
    state = await assist(client, prompt="A sunken city full of secrets", kind="scenario",
                         existing={"name": "The Sunken City", "tags": ["adventure"]})
    draft = state["draft"]
    # creator's fields win over the model's
    assert draft["name"] == "The Sunken City"
    assert draft["tags"] == ["adventure"]
    content = fake_provider.captured["payload"].messages[0]["content"]
    assert "SCENARIO" in content
    assert "EXISTING FIELDS" in content


async def test_the_creators_own_fields_are_kept_and_never_missing(client, fake_provider):
    await add_connection(client)
    fake_provider.script = [ProviderEvent(type="delta", text=CARD_JSON[:100]),
                            ProviderEvent(type="done", stop="length")]
    state = await assist(client, existing={"greeting": "Mine.", "tags": ["kept"], "name": ""})
    assert state["draft"] == {"name": "Nyra", "tagline": CARD["tagline"],
                              "greeting": "Mine.", "tags": ["kept"]}
    assert state["missing"] == ["description", "personality", "scenario", "alternate_greetings",
                                "example_dialogues", "lore_entries"]


async def test_assist_without_connection_fails_readably_at_the_start(client, fake_provider):
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 400
    assert resp.json()["kind"] == "no_connection"
    assert "connection" in resp.json()["error"].lower()
    assert card_assistant._jobs == {}


async def test_an_answer_with_no_card_field_is_empty_and_one_with_nothing_readable_is_unreadable(
        client, fake_provider):
    await add_connection(client)
    fake_provider.script = [ProviderEvent(type="delta", text="not json"),
                            ProviderEvent(type="done")]
    state = await assist(client)
    assert (state["error"]["kind"], state["draft"]) == ("model_unreadable", None)
    assert state["missing"] == list(card_assistant.CARD_FIELDS)

    fake_provider.script = [ProviderEvent(type="delta", text='{"personnage": {"nom": "Ana"}}'),
                            ProviderEvent(type="done")]
    state = await assist(client)
    assert (state["error"]["kind"], state["draft"]) == ("model_empty", None)


async def test_assist_repairs_rp_model_json(client, fake_provider):
    """Literal newlines in strings + fence + chatter: the real Cydonia case."""
    await add_connection(client)
    messy = ('Voici votre fiche :\n```json\n{\n"name": "Kenji Sato",\n'
             '"greeting": "*Rain falls on Kabukicho.*\nTu n\'es personne, {{user}}.",\n'
             '"tags": ["yakuza", "realistic"],\n}\n```\nHave a good game!')
    fake_provider.script = [ProviderEvent(type="delta", text=messy), ProviderEvent(type="done")]
    state = await assist(client, prompt="japanese gangster")
    assert state["error"] is None
    assert state["draft"]["name"] == "Kenji Sato"
    assert "Kabukicho" in state["draft"]["greeting"]


def sent_ceiling(fake_provider):
    return fake_provider.captured["connection"]["max_tokens"]


@pytest.mark.parametrize(("ceiling", "sent"), [(512, 4096), (4096, 4096), (8000, 8000),
                                               (None, None)])
async def test_assist_raises_only_a_ceiling_the_connection_has(client, fake_provider,
                                                               ceiling, sent):
    await add_connection(client, max_tokens=ceiling)
    await assist(client, prompt="japanese gangster")
    assert sent_ceiling(fake_provider) == sent


async def test_the_raised_ceiling_stays_within_what_the_context_leaves(client, fake_provider):
    await add_connection(client, max_tokens=512, context_size=4096)
    await assist(client, prompt="japanese gangster")
    payload = fake_provider.captured["payload"]
    prompt = estimate_tokens(payload.system) + estimate_tokens(payload.messages[0]["content"])
    assert 512 < sent_ceiling(fake_provider) < 4096
    assert sent_ceiling(fake_provider) + prompt <= 4096


async def test_a_context_that_cannot_hold_the_instructions_and_a_card_is_said_before_the_model(
        client, fake_provider):
    """The instructions and the least room a card is written in are past a context of 1024."""
    await add_connection(client, max_tokens=900, context_size=1024)
    resp = await client.post("/api/characters/assist", json={"prompt": "japanese gangster"})
    assert resp.status_code == 422 and resp.json()["params"]["context"] == 1024, resp.text
    assert fake_provider.captured == {}


async def test_assist_returns_lore_entries(client, fake_provider):
    await add_connection(client)
    with_lore = json.dumps({
        "name": "Kenji", "tagline": "\ud800",
        "lore_entries": [
            {"keys": ["Kabukicho", "kabukicho"], "content": "The red-light district of Shinjuku."},
            {"keys": ["clan Sato", "\ud800"], "content": "The family that runs the docks."},
            {"keys": [], "content": "Entry with no keyword, to discard."},
            {"keys": ["vide"], "content": "   "},
            "not an object",
        ],
    })
    fake_provider.script = [ProviderEvent(type="delta", text=with_lore), ProviderEvent(type="done")]
    state = await assist(client, prompt="yakuza")
    draft = state["draft"]
    assert len(draft["lore_entries"]) == 2 and state["lore"] == 2  # invalid entries filtered out
    assert draft["lore_entries"][0]["keys"] == ["Kabukicho"]  # one keyword, in two cases
    assert "Shinjuku" in draft["lore_entries"][0]["content"]
    # A lone surrogate, which an escape in the answer gives, cannot be written to the response.
    assert "tagline" not in draft and draft["lore_entries"][1]["keys"] == ["clan Sato"]


async def test_a_keyword_the_model_writes_twice_in_an_entry_comes_once(client, fake_provider):
    await add_connection(client)
    await answers(fake_provider, {"name": "Kenji", "lore_entries": [
        {"keys": ["Dragon", "dragon", "Dragon", "DRAGON ", "Wyrm"], "content": "c"}]})
    state = await assist(client, prompt="yakuza")
    assert state["draft"]["lore_entries"][0]["keys"] == ["Dragon", "Wyrm"]


async def test_a_long_brief_that_fits_the_connections_context_is_accepted(client, fake_provider):
    # A community card's « about » runs well past ten thousand characters.
    await add_connection(client, context_size=128_000)
    state = await assist(client, prompt="A pirate. " * 4_000)
    assert state["draft"]["name"] == "Nyra"
    assert ("A pirate. " * 4_000).strip() in fake_provider.captured["payload"].messages[0]["content"]


async def test_a_brief_the_connections_context_cannot_hold_is_refused_before_the_model(
        client, fake_provider):
    await add_connection(client, context_size=16_384)
    jobs = len(card_assistant._jobs)
    resp = await client.post("/api/characters/assist", json={"prompt": "x" * 100_000})
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["kind"] == "brief_too_long"
    # What the request would need: the brief, the assistant's instructions, and room for the card.
    assert body["params"]["context"] == 16_384
    assert body["params"]["needed"] > estimate_tokens("x" * 100_000)
    assert fake_provider.captured == {}  # the model was never asked
    assert len(card_assistant._jobs) == jobs


@pytest.mark.parametrize(("context", "ceiling"), [(16_384, 16_000), (4_096, 4_096), (16_384, 8_192)])
async def test_a_connections_own_ceiling_takes_no_room_from_the_brief(client, fake_provider,
                                                                       context, ceiling):
    """The app tells people to raise max tokens; a ceiling close to the context, as chat does with
    it, still lets a brief through, and is sent as the connection sets it."""
    await add_connection(client, context_size=context, max_tokens=ceiling)
    # What fits the context with the instructions and the least room a card is written in.
    brief = "x" * int((context - estimate_tokens(CARD_ASSISTANT_PROMPT) - 1_400) * 3.5)
    for prompt in ("A seller of maps", brief):
        resp = await client.post("/api/characters/assist", json={"prompt": prompt})
        assert resp.status_code == 202, (context, ceiling, len(prompt), resp.text)
        await within(2, card_assistant._jobs[resp.json()["id"]].finished.wait())
        assert sent_ceiling(fake_provider) == ceiling


async def test_what_the_card_already_holds_is_told_apart_from_the_brief(client, fake_provider):
    """A short brief on a card whose fields alone outgrow the context: shortening the brief would
    not help, and the person is told it is the card."""
    await add_connection(client, context_size=16_384)
    resp = await client.post("/api/characters/assist", json={
        "prompt": "A seller of maps", "existing": {"description": "y" * 60_000}})
    assert resp.status_code == 422, resp.text
    assert resp.json()["kind"] == "card_too_long"
    assert resp.json()["params"]["context"] == 16_384
    # The same overflow from the brief alone is the brief's.
    resp = await client.post("/api/characters/assist", json={"prompt": "y" * 60_000})
    assert resp.json()["kind"] == "brief_too_long"


async def test_the_tokens_needed_are_told_to_the_hundred(client, fake_provider):
    """An estimate, said as one: "about 28 700", not "about 28 659"."""
    await add_connection(client, context_size=16_384)
    resp = await client.post("/api/characters/assist", json={"prompt": "x" * 100_000})
    needed = resp.json()["params"]["needed"]
    assert needed % 100 == 0 and needed > estimate_tokens("x" * 100_000)


async def test_the_room_left_for_the_card_counts_in_what_a_brief_may_take(client, fake_provider):
    """A brief that leaves the card no room would come back cut, or be refused by the model's server."""
    await add_connection(client, context_size=16_384)
    instructions = estimate_tokens(CARD_ASSISTANT_PROMPT)
    # Fits with the instructions alone, not once the room for a card is counted.
    words = int((16_384 - instructions - 1_000) * 3.5)
    resp = await client.post("/api/characters/assist", json={"prompt": "x" * words})
    assert resp.status_code == 422 and resp.json()["kind"] == "brief_too_long", resp.text


async def answers(fake_provider, card: dict) -> None:
    fake_provider.script = [ProviderEvent(type="delta", text=json.dumps(card)),
                            ProviderEvent(type="done")]


async def test_a_tag_the_model_writes_twice_comes_once(client, fake_provider):
    """Tags are lowercased: "Fantasy" and "fantasy " are then the same tag, which the form showed twice."""
    await add_connection(client)
    await answers(fake_provider, {"name": "Nyra",
                                  "tags": ["Fantasy", "fantasy ", " FANTASY", "Mystery", "fantasy"]})
    state = await assist(client)
    assert state["draft"]["tags"] == ["fantasy", "mystery"]


async def test_tags_the_card_has_are_its_own_and_come_once(client, fake_provider):
    await add_connection(client)
    await answers(fake_provider, {"name": "Nyra", "tags": ["fantasy", "mystery", "noir"]})
    state = await assist(client, existing={"tags": ["Fantasy", " Mystery "]})
    assert state["draft"]["tags"] == ["Fantasy", " Mystery "]


async def test_an_alternate_greeting_the_model_writes_twice_comes_once(client, fake_provider):
    await add_connection(client)
    await answers(fake_provider, {"name": "Nyra", "alternate_greetings": [
        "*The shop is empty.*", "*the shop is empty.* ", "*Rain on the glass.*"]})
    state = await assist(client)
    assert state["draft"]["alternate_greetings"] == ["*The shop is empty.*", "*Rain on the glass.*"]


async def test_a_lore_entry_the_card_already_has_is_not_added_again(client, fake_provider):
    await add_connection(client)
    await answers(fake_provider, {"name": "Kenji", "lore_entries": [
        {"keys": ["kabukicho "], "content": "The red-light district, again."},
        {"keys": ["Docks"], "content": "Where the clan sells salt."},
        {"keys": ["docks"], "content": "The docks, twice in one answer."},
        {"keys": ["Kabukicho", "Shinjuku"], "content": "Covers a subject the book lacks."},
    ]})
    state = await assist(client, prompt="yakuza", existing={
        "lore_entries": [{"keys": ["Kabukicho"], "content": "already written"}]})
    assert [e["keys"] for e in state["draft"]["lore_entries"]] == [["Docks"], ["Kabukicho", "Shinjuku"]]
    assert state["lore"] == 2


@pytest.mark.parametrize("drafted", [
    # The model wrote the entries the book has: dropped as repeats, they were written all the same.
    [{"keys": ["Kabukicho"], "content": "The district, again."}],
    # The model wrote none: the card has a lorebook already.
    [],
])
async def test_a_card_that_has_a_lorebook_is_not_told_it_lacks_one(client, fake_provider, drafted):
    await add_connection(client)
    await answers(fake_provider, {"name": "Kenji", "lore_entries": drafted})
    state = await assist(client, prompt="yakuza", existing={
        "lore_entries": [{"keys": ["Kabukicho"], "content": "already written"}]})
    assert "lore_entries" not in state["missing"], state["missing"]


async def test_a_card_with_no_lorebook_that_got_none_still_lacks_one(client, fake_provider):
    await add_connection(client)
    await answers(fake_provider, {"name": "Kenji"})
    state = await assist(client, prompt="yakuza")
    assert "lore_entries" in state["missing"]


async def test_assist_avoids_duplicating_existing_lore(client, fake_provider):
    await add_connection(client)
    await assist(client, prompt="yakuza",
                 existing={"lore_entries": [{"keys": ["Kabukicho"], "content": "already written"}]})
    content = fake_provider.captured["payload"].messages[0]["content"]
    assert "EXISTING LOREBOOK KEYWORDS" in content
    assert "Kabukicho" in content


async def test_assist_reads_lore_entries_from_a_list_only_and_their_keys_as_a_drafts(
        client, fake_provider):
    """A lorebook that is no list holds no entry, and fails no request. The keys of an entry
    are read as a draft's are: a bare string is one keyword, a number or an object none."""
    await add_connection(client)
    for existing in ({"lore_entries": 5}, {"lore_entries": "Kabukicho"},
                     {"lore_entries": {"keys": ["Kabukicho"], "content": "c"}},
                     {"lore_entries": True}):
        drafted = json.dumps({"name": "Kenji", **existing})
        fake_provider.script = [ProviderEvent(type="delta", text=drafted), ProviderEvent(type="done")]
        state = await assist(client, prompt="yakuza", existing=existing)
        assert state["draft"] == {"name": "Kenji"}, existing
        content = fake_provider.captured["payload"].messages[0]["content"]
        assert "EXISTING LOREBOOK KEYWORDS" not in content, existing

    await assist(client, prompt="yakuza", existing={"lore_entries": [
        {"keys": "Kabukicho"}, {"keys": 5}, {"keys": {"Shinjuku": 1}}, {"keys": None},
        {"keys": ["clan"]},
    ]})
    content = fake_provider.captured["payload"].messages[0]["content"]
    assert "EXISTING LOREBOOK KEYWORDS (cover other subjects):\nKabukicho, clan\n" in content


async def test_stopping_keeps_what_was_complete_and_cancels_the_request_to_the_model(
        client, paced):
    await add_connection(client)
    job_id = await begin(client)
    await paced(ProviderEvent(type="delta", text=CARD_JSON[:100]))

    resp = await client.delete(f"/api/characters/assist/{job_id}")

    assert resp.status_code == 200
    state = resp.json()
    assert Paced.closed
    assert (state["running"], state["stopped"], state["error"], state["cut"]) == (
        False, True, None, False)
    assert state["draft"] == {"name": "Nyra", "tagline": CARD["tagline"]}
    # On a job that has ended, a stop changes nothing.
    assert (await client.delete(f"/api/characters/assist/{job_id}")).json() == state


async def test_stopping_before_anything_was_written_gives_no_draft(client, paced):
    await add_connection(client)
    job_id = await begin(client)
    state = (await client.delete(f"/api/characters/assist/{job_id}")).json()
    assert (state["stopped"], state["draft"], state["error"]) == (True, None, None)


async def test_a_server_going_down_leaves_no_request_to_the_model_open(client, paced):
    await add_connection(client)
    job_id = await begin(client)
    await paced(ProviderEvent(type="delta", text=CARD_JSON[:100]))
    job = card_assistant._jobs[job_id]

    job.task.cancel()
    await asyncio.wait({job.task})
    await asyncio.wait({job.reading})

    assert Paced.closed and job.reading.cancelled() and job.finished.is_set()
    assert (job.stopped, job.error, job.draft) == (True, None, {"name": "Nyra",
                                                               "tagline": CARD["tagline"]})


async def test_the_same_client_id_starts_one_job(client, paced):
    await add_connection(client)
    first = await begin(client, client_id="page-1")
    assert await begin(client, client_id="page-1") == first
    other = await begin(client, client_id="page-2")
    assert other != first and len(card_assistant._jobs) == 2
    for job_id in (first, other):
        await client.delete(f"/api/characters/assist/{job_id}")


async def test_an_unknown_id_is_not_found_as_an_assist_not_a_character(client):
    for method in ("get", "delete"):
        resp = await client.request(method, "/api/characters/assist/0123456789abcdef")
        assert resp.status_code == 404
        assert (resp.json()["kind"], resp.json()["resource"]) == ("not_found", "assist")


async def test_a_job_is_forgotten_30_minutes_after_it_ended(client, fake_provider, clock):
    await add_connection(client)
    state = await assist(client)
    clock[0] += 30 * 60 - 1
    assert (await state_of(client, state["id"]))["draft"]["name"] == "Nyra"
    clock[0] += 1
    assert (await client.get(f"/api/characters/assist/{state['id']}")).status_code == 404


async def test_the_21st_job_pushes_out_the_oldest_ended_one(client, fake_provider, clock):
    await add_connection(client)
    ids = []
    for _ in range(21):
        ids.append((await assist(client))["id"])
        clock[0] += 1
    assert (await client.get(f"/api/characters/assist/{ids[0]}")).status_code == 404
    for job_id in ids[1:]:
        assert (await client.get(f"/api/characters/assist/{job_id}")).status_code == 200


async def test_a_job_still_running_is_never_pushed_out(client, paced, clock, monkeypatch):
    await add_connection(client)
    running = await begin(client)
    clock[0] += 1
    FakeProvider.script = [ProviderEvent(type="delta", text=CARD_JSON), ProviderEvent(type="done")]
    monkeypatch.setattr("app.services.card_assistant.get_provider", FakeProvider)
    for _ in range(21):
        await assist(client)
        clock[0] += 1
    assert len(card_assistant._jobs) == 20
    assert (await state_of(client, running))["running"] is True
    await client.delete(f"/api/characters/assist/{running}")


def warnings_of(caplog):
    return [r for r in caplog.records if r.levelno == logging.WARNING]


async def test_a_failed_model_server_is_logged_with_its_kind_and_status(
        client, fake_provider, caplog):
    await add_connection(client)
    fake_provider.script = [ProviderError("Invalid key", "model_auth_refused", 401)]
    state = await assist(client)
    assert state["error"] == {"error": "Invalid key", "kind": "model_auth_refused"}
    [line] = warnings_of(caplog)
    assert line.getMessage() == ("card assistant failed with model_auth_refused: "
                                 "Invalid key (the model's server answered 401)")
    assert line.exc_info is None


async def test_an_unreadable_card_is_logged_with_the_length_and_end_of_the_answer(
        client, fake_provider, caplog):
    await add_connection(client)
    cut = '{"description": "She draws cards for ' + "x" * 200
    fake_provider.script = [ProviderEvent(type="delta", text=cut), ProviderEvent(type="done")]
    state = await assist(client)
    assert state["error"]["kind"] == "model_unreadable"
    unreadable, failed = warnings_of(caplog)
    assert unreadable.getMessage() == (
        f'card assistant: unreadable answer, {len(cut)} characters, ends with "{"x" * 80}"')
    assert "model_unreadable" in failed.getMessage()
    assert all(r.exc_info is None for r in caplog.records)
    assert "She draws cards" not in caplog.text, "only the end of an answer is logged"


async def test_a_newline_in_the_end_of_an_answer_stays_on_one_line(client, fake_provider, caplog):
    await add_connection(client)
    fake_provider.script = [ProviderEvent(type="delta", text="Sorry,\nI cannot."),
                            ProviderEvent(type="done")]
    await assist(client)
    [line, _] = warnings_of(caplog)
    assert line.getMessage().endswith('16 characters, ends with "Sorry,\\nI cannot."')


async def test_an_error_under_500_leaves_nothing_in_the_log(client, fake_provider, caplog):
    resp = await client.post("/api/characters/assist", json={"prompt": "A pirate"})
    assert resp.status_code == 400
    assert warnings_of(caplog) == []


async def test_an_empty_card_is_logged_with_the_names_of_the_fields_it_had(
        client, fake_provider, caplog):
    await add_connection(client)
    answer = '{"personnage": {"nom": "Ana"}}'
    fake_provider.script = [ProviderEvent(type="delta", text=answer), ProviderEvent(type="done")]
    state = await assist(client)
    assert state["error"]["kind"] == "model_empty"
    empty, failed = warnings_of(caplog)
    assert empty.getMessage() == (
        "card assistant: no card field in the answer, whose fields are ['personnage']; "
        f'{len(answer)} characters, ends with "{answer}"')
    assert "model_empty" in failed.getMessage()
    assert all(r.exc_info is None for r in caplog.records)
