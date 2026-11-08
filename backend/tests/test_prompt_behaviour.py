"""What the prompt engine promises, said directly where no recorded case says it."""

from app.prompting.defaults import DEFAULT_RP_RULES, SCENARIO_RP_RULES
from app.prompting.engine import build_chat_payload, match_lore, select_facts, trim_reply

CHARACTER = {"name": "Mira", "description": "A ferrywoman."}
SMALL = {"context_size": 600, "max_tokens": 50}


def message(position, text, role="user"):
    return {"id": f"m{position}", "role": role, "variants": [text], "position": position}


def fact(id, content, position=0, pinned=False):
    return {"id": id, "content": content, "source_position": position, "is_pinned": pinned}


def test_both_sets_of_rules_keep_the_player_in_charge_of_the_player():
    for rules in (DEFAULT_RP_RULES, SCENARIO_RP_RULES):
        assert "Never speak, act, feel or decide for {{user}}." in rules
        assert "Write your reply in the same language {{user}} writes in." in rules


def test_a_reply_is_cut_where_it_speaks_for_the_player_and_loses_its_name_tag():
    assert trim_reply("Hello.\nAlex: I wave.", "Mira", "Alex") == "Hello."
    assert trim_reply("Hello.\nAlex : I wave.", "Mira", "Alex") == "Hello."
    assert trim_reply("Mira: Hello. ", "Mira", "Alex") == "Hello."
    assert trim_reply("Mira : Hello.", "Mira", "Alex") == "Hello."


def test_a_reply_loses_the_thinking_written_before_it_and_is_nothing_until_that_ends():
    assert trim_reply("<think>She waves.\nAlex: hi?</think>\n\nMira: Hello.", "Mira", "Alex") == "Hello."
    assert trim_reply("\n<think>Still weighing it", "Mira", "Alex") == ""
    assert trim_reply("<thi", "Mira", "Alex") == ""
    assert trim_reply("<3", "Mira", "Alex") == "<3"


def test_the_last_message_survives_however_long_it_is():
    long = "word " * 3000
    payload = build_chat_payload(CHARACTER, None, {}, [message(1, "Hi."), message(2, long)], SMALL)
    assert [m["content"] for m in payload.messages] == [long]


def test_facts_fill_the_budget_by_relevance_when_scored_else_newest_first():
    facts = [fact("a", "Old but relevant.", 1), fact("b", "New and idle.", 9)]
    assert [f["id"] for f in select_facts(facts, 5, {"a": 0.9, "b": 0.1})] == ["a"]
    assert [f["id"] for f in select_facts(facts, 5)] == ["b"]


def test_a_pinned_fact_is_kept_outside_the_budget():
    pinned = fact("p", "The seal is broken. " * 50, 1, pinned=True)
    assert select_facts([pinned], 1) == [pinned]


def test_lore_comes_in_the_order_of_the_lorebook_and_keys_ignore_case():
    entries = [{"keys": ["Harbor"], "content": "first"}, {"keys": ["harbor"], "content": "second"}]
    assert [e["content"] for e in match_lore(entries, [message(1, "the HARBOR")])] == [
        "first", "second"]
    assert match_lore(entries[::-1], [message(1, "the harbor")]) == entries[::-1]


def test_no_more_facts_than_the_cap_and_the_history_leaves_a_margin_below_the_window():
    assert len(select_facts([fact(str(i), "f", i) for i in range(80)], 1000)) == 60
    stats = build_chat_payload(CHARACTER, None, {}, [message(1, "Hi.")], {"context_size": 2000}).stats
    assert stats["budget"] == 776  # 2000 - 1024 default reply - 200 margin
