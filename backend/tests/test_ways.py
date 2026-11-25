"""The ways of playing as the engine reads them: balanced is today's figures, and the rules that
turn a way's six reminder fields into budgets. Parity with the TypeScript engine is in the
recorded cases (tests/cases/ways.json)."""

import json
from pathlib import Path

import pytest

from app.prompting import ways
from app.prompting.engine import build_chat_payload
from app.prompting.tokens import estimate_tokens
from app.services import ai_call

CASES = Path(__file__).parent / "cases"
SIX = ways.REMINDER_FIELDS


def chat_case(name):
    cases = json.loads((CASES / "chat.json").read_text(encoding="utf-8"))["cases"]
    return next(c["input"] for c in cases if c["name"] == name)


def reminders_of(way_id):
    return {k: ways.BUILT_IN[way_id][k] for k in SIX}


def without_parts(payload):
    stats = {k: v for k, v in payload.stats.items() if k != "parts"}
    return payload.system, payload.messages, payload.stop, payload.post_history, stats


def long_story(card_rules):
    """A story longer than its budget, with 80 facts and three entries that fire."""
    messages = [{"role": "user" if i % 2 else "assistant", "position": i,
                 "variants": [f"Turn {i} by the lighthouse, where the keeper waits. " * 6]}
                for i in range(1, 121)]
    memories = [{"id": f"m{i}", "content": f"Fact number {i} about the keeper and the sea.",
                 "is_pinned": i in (3, 40), "source_position": i, "source": "model"}
                for i in range(1, 81)]
    lore = [{"keys": ["lighthouse"], "content": "The lighthouse was built in 1820. " * 10},
            {"keys": ["keeper"], "content": "The keeper never leaves the tower. " * 8},
            {"keys": ["sea"], "content": "The sea is cold all year. " * 4}]
    return {
        "character": {"name": "Ana", "description": "A keeper of a lighthouse.",
                      "card_rules": card_rules},
        "persona": {"name": "Alex"},
        "conversation": {"id": "c1", "summary": ""},
        "messages": messages,
        "connection": {"context_size": 8192, "max_tokens": 1024},
        "memories": memories,
        "lore_entries": lore,
    }


@pytest.mark.parametrize("budget", [512, 3000, 15160, 100_000])
def test_balanced_is_today_figure_for_figure(budget):
    balanced = reminders_of("balanced")
    assert ways.facts_budget(balanced, budget) == ways.facts_budget(None, budget)
    assert ways.lore_budget(balanced, budget) == ways.lore_budget(None, budget)
    assert ways.passage_budget(balanced, budget) == ways.passage_budget(None, budget)
    assert ways.max_facts(balanced) == ways.max_facts(None)


@pytest.mark.parametrize("given", [
    chat_case("history too long for the budget"), long_story(1), long_story(2),
])
def test_balanced_gives_today_s_prompt(given):
    today = build_chat_payload(**given)
    balanced = build_chat_payload(**given, reminders=reminders_of("balanced"))
    assert without_parts(balanced) == without_parts(today)
    # Today's engine, no way given, reports what it always has.
    assert "parts" not in today.stats
    assert "parts" in balanced.stats


def test_maximum_is_immersive_that_rereads_all():
    maximum, immersive = ways.BUILT_IN["maximum"], ways.BUILT_IN["immersive"]
    assert {k: maximum[k] for k in SIX} == {k: immersive[k] for k in SIX}
    assert maximum["history_limit"] == 0
    assert set(maximum) == set(ways.FIELDS)


def test_the_smaller_of_a_cap_and_a_share_wins():
    rich = ways.LEVELS["rich"]
    assert ways.lore_budget(rich, 16000) == 960
    assert ways.lore_budget(rich, 40000) == 1600
    assert ways.lore_budget(ways.LEVELS["all"], 40000) == 2400
    unbounded = {**ways.LEVELS["all"], "lore_share": None, "passage_share": None}
    assert ways.lore_budget(unbounded, 40000) == 40000
    assert ways.passage_budget(unbounded, 40000) == 40000
    assert ways.passage_budget(ways.LEVELS["essential"], 99_999) == 0
    assert ways.facts_budget(ways.LEVELS["all"], 100_000) == 12000
    assert ways.max_facts(ways.LEVELS["all"]) is None


def test_an_unknown_way_is_the_default_then_balanced():
    styles = {"overrides": {}, "custom": []}
    assert ways.way_of(styles, "gone", "light")["id"] == "light"
    fallen = ways.way_of(styles, "gone", "gone-too")
    assert fallen["id"] == "balanced"
    assert ways.way_of({}, None, None)["id"] == "balanced"
    # A custom way that lost a field still has one where the way it came from has one.
    partial = ways.way_of({"custom": [{"id": "mine", "name": None, "history_limit": 30}]},
                          "mine", "balanced")
    for field in ways.FIELDS:
        if ways.BUILT_IN["balanced"][field] is not None:
            assert partial[field] is not None, field
    assert partial["history_limit"] == 30
    assert partial["built_in"] is False


def test_overrides_change_only_this_conversation_s_values():
    balanced = ways.way_of({}, "balanced", None)
    longer = ways.applied(balanced, {"reply_length": "long"})
    assert longer["reply_length"] == "long"
    assert longer["reply_room"] == 2048
    assert longer["adjusted"] is True
    assert balanced["reply_room"] == 1024
    same = ways.applied(balanced, {"history_limit": 24})
    assert same["adjusted"] is False
    everything = ways.applied(balanced, {"reminders": "all"})
    assert {k: everything[k] for k in SIX} == ways.LEVELS["all"]
    assert everything["adjusted"] is True
    assert ways.applied(balanced, None)["adjusted"] is False


def test_a_built_in_with_stored_edits():
    styles = {"overrides": {"balanced": {"history_limit": 30}}, "custom": []}
    way = ways.way_of(styles, "balanced", "balanced")
    assert way["history_limit"] == 30
    assert way["overridden"] is True
    assert way["built_in"] is True
    assert way["name"] is None
    for field in ways.FIELDS:
        if field != "history_limit":
            assert way[field] == ways.BUILT_IN["balanced"][field]
    assert ways.way_of(styles, "light", None)["overridden"] is False


def test_the_way_of_a_conversation():
    settings = {"play_styles": {"overrides": {}, "custom": []}, "default_play_style": "light"}
    assert ways.way_for(None, settings)["id"] == "light"
    assert ways.way_for(None, settings)["adjusted"] is False
    played = ways.way_for({"play_style": "immersive", "play_overrides": {"history_limit": 10}},
                          settings)
    assert (played["id"], played["history_limit"], played["adjusted"]) == ("immersive", 10, True)


def test_the_level_of_six_fields():
    for level, fields in ways.LEVELS.items():
        assert ways.level_of(fields) == level
    assert ways.level_of({**ways.LEVELS["rich"], "max_facts": 90}) is None


def test_the_margin_and_the_ratio_shape_the_budget():
    given = chat_case("history too long for the budget")

    def budget(**connection):
        return build_chat_payload(**{**given, "connection": connection}).stats["budget"]

    assert budget(context_size=16384, max_tokens=1024) == 15160
    assert budget(context_size=16384, max_tokens=1024, margin=983) == 14377
    assert budget(context_size=16384, max_tokens=1024, margin=491, token_ratio=1.25) == 11895
    assert budget(context_size=16384, max_tokens=1024, margin=None, token_ratio=None) == 15160


@pytest.mark.parametrize("name", [
    "order of the blocks",
    "the stats are the eight the chat service reads",
    "a card's note and the entries at its depth are said once, the note first",
    "a card on the rules of community cards: its instructions come after the pinned facts and the scene directive",
])
def test_the_parts_add_up_to_what_is_used(name):
    given = chat_case(name)
    payload = build_chat_payload(**given, reminders=reminders_of("balanced"))
    parts = payload.stats["parts"]
    assert parts["card"] + parts["reminders"] + parts["history"] == payload.stats["used_tokens"]
    assert parts["card"] > 0 and parts["history"] > 0
    if payload.stats["fact_positions"] or payload.stats["lore_matched"]:
        assert parts["reminders"] > 0


def test_a_pinned_fact_said_after_the_story_counts_as_a_reminder():
    given = long_story(1)
    given["memories"] = [{"id": "p", "content": "The keeper is afraid of the dark.",
                          "is_pinned": True, "source_position": 119, "source": "model"}]
    payload = build_chat_payload(**given, reminders=reminders_of("balanced"))
    assert "afraid of the dark" in payload.post_history
    unpinned = build_chat_payload(**{**given, "memories": [{**given["memories"][0],
                                                              "is_pinned": False}]},
                                  reminders=reminders_of("balanced"))
    # Unpinned, its turn is in sight so it is left out everywhere: nothing to remind.
    assert payload.stats["parts"]["reminders"] > unpinned.stats["parts"]["reminders"]


def test_each_level_gives_the_reminders_their_room():
    given = long_story(1)
    light = build_chat_payload(**given, reminders=ways.LEVELS["essential"])
    rich = build_chat_payload(**given, reminders=ways.LEVELS["rich"])
    assert len(rich.stats["fact_positions"]) >= len(light.stats["fact_positions"])
    assert rich.stats["parts"]["reminders"] > light.stats["parts"]["reminders"]


@pytest.mark.parametrize("tokens", [1, 2, 7, 1500, 3000])
def test_a_stand_in_passage_costs_its_budget(tokens):
    [passage] = ways.stand_in_passages(tokens)
    assert estimate_tokens(passage["content"]) == tokens
    assert estimate_tokens(passage["content"][:-1]) < tokens
    assert passage["role"] == "user" and passage["position"] == 0


def test_no_stand_in_for_no_passage():
    assert ways.stand_in_passages(0) == []


def test_the_outlook_counts_in_the_server_s_tokens():
    stats = {"used_tokens": 1000, "budget": 2001, "context_size": 4096, "messages_included": 3,
             "messages_total": 9, "parts": {"card": 500, "reminders": 300, "history": 200}}
    entry = ways.outlook_entry(stats, ratio=1.5, history_limit=24, reply_room=1024, cap_short=None)
    assert entry == {"used_tokens": 1500, "budget": 3002, "context_size": 4096,
                     "messages_included": 3, "messages_total": 9, "history_limit": 24,
                     "reply_room": 1024, "parts": {"card": 750, "reminders": 450, "history": 300},
                     "cap_short": None}
    # Half to even, as Python rounds.
    assert ways.outlook_entry({**stats, "used_tokens": 5}, ratio=0.5, history_limit=0,
                              reply_room=512, cap_short=8)["used_tokens"] == 2


def test_the_reserve_with_no_room_of_its_own():
    model = {"reply_cap_mode": "auto", "reply_cap_tokens": None, "reasons": 0, "output_read": None}

    def reserve(window, **changes):
        return ai_call.ceiling({**model, **changes}, anthropic=False, family="generic",
                               room=None, window=window).reserve

    assert reserve(16384) == 4096
    assert reserve(8192) == 2048
    assert reserve(16384, output_read=1500) == 1500
    assert ai_call.ceiling(model, anthropic=False, family="generic", room=None).reserve == 4096
    anthropic = ai_call.ceiling(model, anthropic=True, family="anthropic", room=None, window=200000)
    assert anthropic.sent == 4096
    # A ceiling the person set, or none sent, does not read the way's room.
    assert reserve(16384, reply_cap_mode="unsent") == ai_call.UNSENT_RESERVE
    assert reserve(16384, reply_cap_mode="fixed", reply_cap_tokens=700) == 700


@pytest.mark.parametrize("output_read, window", [(64000, 200000), (None, 8192), (2500, 200000)])
def test_a_room_left_open_on_anthropic_keeps_what_it_sends(output_read, window):
    # Anthropic refuses a prompt and a ceiling that do not fit the window together.
    model = {"reply_cap_mode": "auto", "reply_cap_tokens": None, "reasons": 0,
             "output_read": output_read}
    got = ai_call.ceiling(model, anthropic=True, family="anthropic", room=None, window=window)
    assert got.sent == got.reserve
    assert got.sent <= ai_call.ANTHROPIC_FLOOR


def test_the_allowance_given_replaces_the_assumed_one():
    model = {"reply_cap_mode": "auto", "reasons": 1, "output_read": None}
    assumed = ai_call.ceiling(model, anthropic=False, family="generic", room=1024).reserve
    assert assumed == 1024 + ai_call.THINKING_ALLOWANCE
    measured = ai_call.ceiling(model, anthropic=False, family="generic", room=1024,
                               allowance=500).reserve
    assert measured == 1524
