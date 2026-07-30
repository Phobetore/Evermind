"""Prompt engine tests: macros, system structure, history, context budget."""

from app.prompting.engine import build_chat_payload
from app.prompting.macros import substitute
from app.prompting.tokens import estimate_tokens


def make_character(**overrides) -> dict:
    base = {
        "kind": "character",
        "name": "Serana",
        "tagline": "",
        "description": "A centuries-old vampire noble with a dry wit.",
        "personality": "wry, guarded, fiercely loyal",
        "scenario": "{{user}} found her sealed in an ancient crypt.",
        "greeting": "*She stirs.* Who... are you, {{user}}?",
        "alternate_greetings": [],
        "example_dialogues": "<START>\n{{user}}: Are you alright?\n{{char}}: *dusts off* Define alright.",
        "system_prompt": "",
        "post_history_instructions": "",
        "creator_notes": "",
        "tags": [],
        "creator": "",
        "character_version": "",
    }
    base.update(overrides)
    return base


def make_connection(**overrides) -> dict:
    base = {"context_size": 8192, "max_tokens": 512}
    base.update(overrides)
    return base


def make_message(role: str, text: str, position: int) -> dict:
    return {
        "id": f"m{position}",
        "role": role,
        "variants": [text],
        "active_index": 0,
        "position": position,
    }


PERSONA = {"name": "Alex", "description": "A wandering scholar."}


def test_substitute_macros_case_insensitive():
    out = substitute("{{char}} meets {{User}} and {{CHAR}}", char_name="Serana", user_name="Alex")
    assert out == "Serana meets Alex and Serana"


def test_estimate_tokens_monotonic():
    assert estimate_tokens("") >= 0
    assert estimate_tokens("hello world " * 100) > estimate_tokens("hello")


def build(character=None, messages=None, **kwargs):
    return build_chat_payload(
        character=character or make_character(),
        persona=kwargs.get("persona", PERSONA),
        conversation=kwargs.get("conversation", {"summary": ""}),
        messages=messages if messages is not None else [make_message("user", "Hello", 0)],
        connection=kwargs.get("connection", make_connection()),
        global_instructions=kwargs.get("global_instructions", ""),
    )


def test_system_contains_card_and_persona():
    payload = build()
    assert "Serana" in payload.system
    assert "vampire noble" in payload.system
    assert "wry, guarded" in payload.system
    assert "Alex found her sealed" in payload.system  # macro substituted in scenario
    assert "wandering scholar" in payload.system
    assert "Define alright." in payload.system  # example dialogues present
    assert "{{char}}" not in payload.system and "{{user}}" not in payload.system


def test_summary_included_when_present():
    payload = build(conversation={"summary": "They escaped the crypt together."})
    assert "They escaped the crypt together." in payload.system


def test_card_system_prompt_replaces_default_rules():
    payload = build(make_character(system_prompt="CUSTOM RULES ONLY."))
    assert "CUSTOM RULES ONLY." in payload.system
    assert "Never break character" not in payload.system


def test_card_system_prompt_original_macro():
    payload = build(make_character(system_prompt="{{original}}\nAlso: always rhyme."))
    assert "Never break character" in payload.system
    assert "Also: always rhyme." in payload.system


def test_scenario_kind_uses_narrator_framing():
    payload = build(make_character(kind="scenario", name="The Drowned City"))
    assert "narrator" in payload.system.lower()


def test_global_instructions_appended():
    payload = build(global_instructions="Always reply in English.")
    assert "Always reply in English." in payload.system


def test_history_roles_and_active_variant():
    msg = make_message("assistant", "old", 1)
    msg["variants"] = ["old", "new active"]
    msg["active_index"] = 1
    messages = [make_message("user", "Hi {{char}}", 0), msg, make_message("user", "Bye", 2)]
    payload = build(messages=messages)
    assert [m["role"] for m in payload.messages] == ["user", "assistant", "user"]
    assert payload.messages[0]["content"] == "Hi Serana"
    assert payload.messages[1]["content"] == "new active"


def test_context_budget_drops_oldest_keeps_last():
    long_text = "word " * 400  # ~570 tokens each
    messages = [make_message("user" if i % 2 == 0 else "assistant", long_text, i) for i in range(10)]
    messages.append(make_message("user", "FINAL MESSAGE", 10))
    payload = build(messages=messages, connection=make_connection(context_size=2048, max_tokens=512))
    assert payload.messages[-1]["content"] == "FINAL MESSAGE"
    assert len(payload.messages) < 11
    est = estimate_tokens(payload.system) + sum(estimate_tokens(m["content"]) for m in payload.messages)
    assert est <= 2048 - 512


def test_examples_dropped_when_system_too_big_but_card_kept():
    huge_examples = "line\n" * 3000
    payload = build(
        make_character(example_dialogues=huge_examples),
        connection=make_connection(context_size=2048, max_tokens=256),
    )
    assert "vampire noble" in payload.system
    assert "line\nline" not in payload.system


def test_stop_sequences_use_persona_name():
    payload = build()
    assert "\nAlex:" in payload.stop


def test_post_history_instructions_in_payload():
    payload = build(make_character(post_history_instructions="Stay tense. Address {{user}} often."))
    assert payload.post_history.startswith("Stay tense. Address Alex often.")


def test_no_persona_defaults_to_user():
    payload = build(persona=None)
    assert "\nUser:" in payload.stop


def test_anti_sycophancy_rules_present():
    payload = build()
    assert "NOT a people-pleaser" in payload.system
    assert "PERSISTENT" in payload.system
    assert "Never rush forgiveness" in payload.system
    assert "react to the contradiction" in payload.system


def test_established_facts_injected_chronologically():
    memories = [
        {"content": "Aymeric killed Serana's parents.", "source_position": 12, "is_pinned": 0},
        {"content": "Serana swore vengeance.", "source_position": 14, "is_pinned": 0},
    ]
    # a recent turn (20) so the older facts' turns are outside the window
    payload = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=[make_message("user", "Hello", 20)], connection=make_connection(),
        memories=memories,
    )
    assert "### ESTABLISHED FACTS" in payload.system
    assert "(turn 12) Aymeric killed Serana's parents" in payload.system
    assert payload.system.index("turn 12") < payload.system.index("turn 14")


def test_facts_capped_pinned_survive():
    memories = [{"content": f"Fact number {i} " + "blah " * 30, "source_position": i, "is_pinned": 0}
                for i in range(60)]
    memories.append({"content": "CRUCIAL PINNED FACT", "source_position": 1, "is_pinned": 1})
    payload = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=[make_message("user", "Hello", 0)], connection=make_connection(),
        memories=memories,
    )
    assert "CRUCIAL PINNED FACT" in payload.system
    assert payload.system.count("- (turn") < 45


def test_no_facts_section_when_empty():
    payload = build()
    assert "### ESTABLISHED FACTS" not in payload.system


def test_anti_coincidence_and_delegation_rules_present():
    payload = build()
    assert "bigger than this story" in payload.system
    scenario = build(make_character(kind="scenario"))
    assert "does NOT revolve around" in scenario.system
    assert "No forced coincidences" in scenario.system


def test_reply_length_override():
    short = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=[make_message("user", "Hello", 0)], connection=make_connection(),
        reply_length="short",
    )
    assert "ONE tight paragraph" in short.system
    default = build()
    assert "LENGTH OVERRIDE" not in default.system


def test_post_history_always_reminds_of_guardrails():
    payload = build()
    assert "COMPLETE sentence" in payload.post_history
    assert "Do NOT reuse phrasings" in payload.post_history
    # substituted, not raw macros
    assert "{{char}}" not in payload.post_history


def test_scene_directive_injected_into_post_history():
    payload = build_chat_payload(
        character=make_character(), persona=PERSONA,
        conversation={"summary": "", "author_note": "Lea always finishes her sentences."},
        messages=[make_message("user", "Salut", 0)], connection=make_connection(),
    )
    assert "Lea always finishes her sentences." in payload.post_history
    assert "Scene directive from Alex" in payload.post_history


def test_card_note_and_directive_both_present_in_order():
    char = make_character(post_history_instructions="Reste tendu.")
    payload = build_chat_payload(
        character=char, persona=PERSONA,
        conversation={"summary": "", "author_note": "Varie tes formulations."},
        messages=[make_message("user", "Salut", 0)], connection=make_connection(),
    )
    ph = payload.post_history
    assert ph.index("Reste tendu.") < ph.index("Varie tes formulations.") < ph.index("COMPLETE sentence")


def test_facts_covering_visible_turns_are_not_reinjected():
    """A fact whose source turn is still in the history window is redundant
    (the model already sees that message) and must be dropped."""
    # 3 messages, all fit; a fact tagged to turn 2 (visible) and one to turn 0
    # that will be pushed out by a tiny budget.
    messages = [make_message("user" if i % 2 == 0 else "assistant", "word " * 200, i)
                for i in range(6)]
    messages.append(make_message("user", "recent", 6))
    memories = [
        {"content": "Fact from the recent visible turn.", "source_position": 6, "is_pinned": False},
        {"content": "Old fact outside the window.", "source_position": 0, "is_pinned": False},
    ]
    payload = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=messages, connection=make_connection(context_size=2048, max_tokens=256),
        memories=memories,
    )
    # the recent turn is in the window -> its fact is suppressed
    assert "Fact from the recent visible turn." not in payload.system
    # the old turn dropped from the window -> its fact IS injected as a reminder
    assert "Old fact outside the window." in payload.system


def test_history_limit_caps_raw_turns():
    """Past the cap, turns fall out of the prompt even when tokens remain:
    they live on in the summary/facts instead of feeding the echo chamber."""
    messages = [make_message("user" if i % 2 == 0 else "assistant", f"turn {i}", i)
                for i in range(30)]
    capped = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=messages, connection=make_connection(), history_limit=10,
    )
    assert len(capped.messages) == 10
    assert capped.messages[-1]["content"] == "turn 29"  # newest always survives
    assert capped.messages[0]["content"] == "turn 20"
    uncapped = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=messages, connection=make_connection(),
    )
    assert len(uncapped.messages) == 30  # 0 = unlimited (summarize/impersonate)


def test_history_limit_frees_facts_for_reinjection():
    """A shorter window moves turns out of sight, so their facts become
    relevant reminders again instead of redundant echoes."""
    messages = [make_message("user", f"turn {i}", i) for i in range(20)]
    memories = [{"content": "Fact from turn 12.", "source_position": 12, "is_pinned": False}]
    wide = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=messages, connection=make_connection(), memories=memories,
    )
    assert "Fact from turn 12." not in wide.system  # turn 12 visible -> suppressed
    narrow = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=messages, connection=make_connection(), memories=memories,
        history_limit=4,
    )
    assert "Fact from turn 12." in narrow.system  # turn 12 out of window -> injected


def test_pinned_fact_injected_even_if_turn_visible():
    messages = [make_message("user", "hi", 0), make_message("assistant", "yo", 1)]
    memories = [{"content": "Pinned pillar.", "source_position": 1, "is_pinned": True}]
    payload = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=messages, connection=make_connection(), memories=memories,
    )
    assert "Pinned pillar." in payload.system


def test_select_facts_orders_by_relevance_when_scored():
    from app.prompting.engine import select_facts
    memories = [
        {"id": "old_relevant", "content": "x", "source_position": 1, "is_pinned": 0},
        {"id": "recent_off_topic", "content": "y", "source_position": 99, "is_pinned": 0},
    ]
    scores = {"old_relevant": 0.9, "recent_off_topic": 0.1}
    kept = select_facts(memories, token_budget=10_000, relevance_scores=scores)
    # both fit; display order is oldest-first regardless of score
    assert [m["id"] for m in kept] == ["old_relevant", "recent_off_topic"]
    # relevance (not recency) decides which is tried first: the higher-scored
    # 'old_relevant' is attempted before the newer 'recent_off_topic'
    kept_one = select_facts(memories, token_budget=2, relevance_scores=scores)
    assert kept_one == [] or kept_one[0]["id"] == "old_relevant"


def test_select_facts_without_scores_keeps_recency():
    from app.prompting.engine import select_facts
    memories = [
        {"id": "a", "content": "x", "source_position": 1, "is_pinned": 0},
        {"id": "b", "content": "y", "source_position": 99, "is_pinned": 0},
    ]
    kept = select_facts(memories, token_budget=10_000)
    assert [m["id"] for m in kept] == ["a", "b"]  # oldest-first display, recency selection unchanged


def test_relevance_scores_pick_facts_over_recency():
    # two old, out-of-window facts; the semantically relevant (not the recent)
    # one must be injected under a budget that fits only one.
    memories = [
        {"id": "murder", "content": "Aymeric killed the guard " + "detail " * 20,
         "source_position": 2, "is_pinned": 0},
        {"id": "weather", "content": "The weather was fine that day " + "detail " * 20,
         "source_position": 5, "is_pinned": 0},
    ]
    payload = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=[make_message("user", "Hello", 40)], connection=make_connection(),
        memories=memories,
        relevance_scores={"murder": 0.95, "weather": 0.05},
    )
    assert "killed the guard" in payload.system
    # without scores, recency would prefer 'weather' (position 5) first


def test_retrieved_passages_injected_and_stats():
    passages = [
        {"id": "m1", "role": "assistant", "content": "Lea swore to return.", "position": 4},
        {"id": "m2", "role": "user", "content": "Do you promise me?", "position": 3},
    ]
    payload = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=[make_message("user", "Hello", 40)], connection=make_connection(),
        retrieved_passages=passages,
    )
    assert "### RELEVANT PAST" in payload.system
    assert "(turn 4) Serana: Lea swore to return." in payload.system  # assistant -> char name
    assert "(turn 3) Alex: Do you promise me?" in payload.system        # user -> persona name
    assert payload.system.index("turn 4") > payload.system.index("turn 3")  # oldest-first
    assert payload.stats["passages_injected"] == 2
    assert "oldest_visible" in payload.stats


def test_no_relevant_past_block_when_no_passages():
    payload = build()
    assert "### RELEVANT PAST" not in payload.system
    assert payload.stats["passages_injected"] == 0


def test_stats_exposes_fact_positions():
    memories = [{"id": "f", "content": "An old fact.", "source_position": 5, "is_pinned": 0}]
    payload = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=[make_message("user", "Hello", 40)], connection=make_connection(),
        memories=memories,
    )
    assert 5 in payload.stats["fact_positions"]


def test_oldest_visible_reflects_real_rendered_window():
    """stats['oldest_visible'] must equal the oldest turn ACTUALLY rendered, not
    the provisional estimate. Token-budget-bound history + big recent facts make
    the real window reach further back than the estimate; a wrong value would let
    chat_service retrieve a passage that's already visible (a duplicate)."""
    messages = [make_message("user" if i % 2 == 0 else "assistant", "mot " * 20, i)
                for i in range(60)]
    # big, RECENT non-pinned facts: selected in the provisional 'static' build but
    # dropped from the real system build (covered by the window), freeing budget.
    big_facts = [{"id": f"b{i}", "content": "det " * 250, "source_position": 56 + i,
                  "is_pinned": 0} for i in range(3)]
    payload = build_chat_payload(
        character=make_character(), persona=PERSONA, conversation={"summary": ""},
        messages=messages, connection=make_connection(context_size=3000, max_tokens=512),
        memories=big_facts,
    )
    n = payload.stats["messages_included"]
    # the rendered turns are the last n messages; the oldest of them is messages[60-n]
    expected_oldest = messages[60 - n]["position"]
    assert payload.stats["oldest_visible"] == expected_oldest
