"""Which lorebook entries fire, on the rules of community cards (2) and on Evermind's own (1)."""

import time
from dataclasses import asdict

from app.prompting.engine import _BUDGET_MARGIN, build_chat_payload, match_lore
from app.prompting.lorebook import key_matches, strip_decorators
from app.prompting.payloads import build_impersonate_payload
from app.prompting.tokens import estimate_tokens
from app.services.chat_service import _CONTINUE_INSTRUCTION

from .conftest import PERSONA, make_character, make_connection, make_message


def entry(keys, content="Lore.", **settings):
    return {"keys": keys, "content": content, **settings}


def costing(tokens, letter):
    """A content the engine counts as exactly so many tokens."""
    content = letter * -(-7 * (tokens - 1) // 2)
    assert estimate_tokens(content) == tokens
    return content


def fired(entries, messages, **arguments):
    """The contents of the entries that fire on the rules of community cards."""
    found = match_lore(entries, messages, rules=2, char_name="Ana", user_name="Alex", **arguments)
    return [e["content"] for e in found]


def said(*texts):
    """A conversation in two voices: the person first, then the character, in turn."""
    return [make_message("user" if i % 2 == 0 else "assistant", text, i) for i, text in enumerate(texts)]


def payload(character, entries, messages, **connection):
    return asdict(build_chat_payload(
        character=character, persona=PERSONA, conversation={"summary": ""},
        messages=messages, connection=make_connection(**connection), lore_entries=entries))


def test_a_card_on_the_old_rules_ignores_every_new_setting():
    messages = said("The dragon circles over the moat.")
    plain = [entry(["dragon"], "@@activate\nDragons hoard gold."), entry(["castle"], "Castles stand."),
             entry(["moat"], "Moats are deep.")]
    settings = [
        {"constant": False, "whole_words": False, "position": 7, "selective": True,
         "secondary_keys": ["unicorn"], "selective_logic": 3, "prevent_recursion": True},
        {"constant": True, "whole_words": True, "exclude_recursion": True, "insertion_order": 900,
         "position": 0, "depth": 0, "role": "user", "comment": "Always."},
        {"selective": True, "secondary_keys": ["dragon"], "selective_logic": 2, "position": 4},
    ]
    with_settings = [{**e, **s} for e, s in zip(plain, settings, strict=True)]

    note = {"character_note": "Remember the storm.", "character_note_depth": 0, "character_note_role": "user"}

    before = payload(make_character(), plain, messages)
    assert payload(make_character(card_rules=1, **note), with_settings, messages) == before
    assert payload(make_character(**note), with_settings, messages) == before
    assert "@@activate" in before["system"]
    assert "Castles stand." not in before["system"]


def test_a_single_word_key_matches_whole_words_only():
    assert not key_matches("ring", "bring it here", True)
    assert key_matches("ring", "a ring, then", True)
    assert key_matches("ring", "she wears the ring", True)
    assert key_matches("ring", "ring.", True)
    assert key_matches("RING", "bring the ring", True)
    assert key_matches("ring", "bring it here", False)


def test_a_key_of_several_words_is_a_substring():
    assert key_matches("old ring", "the bold ringmaster", True)
    # Any of the spaces counts, written as escapes so the eye sees which one, while a key
    # of one word on the same text stays whole.
    assert key_matches("old\u00a0ring", "the bold\u00a0ringmaster", True)
    assert key_matches("old\tring", "the bold\tringmaster", True)
    assert key_matches("古い\u3000指輪", "その古い\u3000指輪たち", True)
    assert not key_matches("ring", "the bold ringmaster", True)
    assert not key_matches("old ring", "the old  ring", True)


def test_an_accented_letter_counts_as_a_boundary():
    # Only ASCII letters, digits and _ make a word: "ros" is a whole word in "rosé", and
    # "rose" one in "rosé" written with a combining accent.
    assert key_matches("ros", "un rosé", True)
    assert key_matches("rose", "un rosé", True)
    assert key_matches("rosé", "un rosé, frais", True)
    assert key_matches("東京", "東京に行く", True)
    assert not key_matches("rose", "roses", True)


def test_a_regex_key_never_fires():
    assert not key_matches("/ring/i", "/ring/i and a ring", True)
    assert not key_matches("/ring/", "/ring/", False)
    assert not key_matches("  /ring/gim ", "ring", True)
    assert key_matches("//", "a // b", True)
    assert fired([entry(["/dragon/i"])], said("A dragon. /dragon/i")) == []


def test_an_always_on_entry_fires_without_keywords_and_a_disabled_one_never():
    entries = [entry([], "Always.", constant=True),
               entry([], "Switched off.", constant=True, enabled=False),
               entry(["dragon"], "Off too.", enabled=False),
               entry(["dragon"], "On.")]
    assert fired(entries, said("A dragon.")) == ["Always.", "On."]


def test_secondary_keys_count_only_when_selective_and_follow_their_logic():
    messages = said("The dragon sleeps by the gold.")

    def fires(secondary, logic, selective=True):
        return fired([entry(["dragon"], selective=selective, secondary_keys=secondary,
                            selective_logic=logic)], messages) == ["Lore."]

    # At least one.
    assert fires(["gold", "silver"], 0)
    assert not fires(["silver", "copper"], 0)
    # Not all.
    assert fires(["gold", "silver"], 1)
    assert not fires(["gold", "sleeps"], 1)
    # None.
    assert fires(["silver", "copper"], 2)
    assert not fires(["gold", "silver"], 2)
    # All.
    assert fires(["gold", "sleeps"], 3)
    assert not fires(["gold", "silver"], 3)
    # Not selective, or nothing left once trimmed: the secondary keys are not read.
    assert fires(["silver"], 3, selective=False)
    assert fires(["  ", ""], 3)
    assert not fires(["gold"], 2) and fires(["gold"], 2, selective=False)


def test_an_entry_can_call_another_unless_told_not_to():
    messages = said("I draw the sword.")
    sword = entry(["sword"], "The sword was forged by the smith.")
    smith = entry(["smith"], "The smith lives in the hills.")
    hills = entry(["hills"], "Wolves roam the hills.")
    assert fired([sword, smith, hills], messages) == [sword["content"], smith["content"], hills["content"]]

    assert fired([{**sword, "prevent_recursion": True}, smith, hills], messages) == [sword["content"]]
    assert fired([sword, {**smith, "exclude_recursion": True}, hills], messages) == [sword["content"]]
    # Excluded from recursion, it still fires on what was said.
    assert fired([sword, entry(["sword"], "Seen.", exclude_recursion=True)], messages) == [
        sword["content"], "Seen."]


def test_two_entries_that_call_each_other_end_the_scan():
    entries = [entry(["alpha"], "Beta follows."), entry(["beta"], "Alpha follows."),
               entry(["gamma"], "Gamma, gamma, gamma."), entry(["delta"], "Never said.")]
    assert fired(entries, said("Alpha and gamma.")) == [
        "Beta follows.", "Alpha follows.", "Gamma, gamma, gamma."]


def test_decorator_lines_never_reach_the_model():
    assert strip_decorators("@@activate\n@@depth 2\n\nThe real text.\n@@ kept") == "The real text.\n@@ kept"
    assert strip_decorators("@@only") == ""
    assert strip_decorators("@@activate\r\n\r\nText") == "Text"
    assert strip_decorators("Text first.\n@@activate") == "Text first.\n@@activate"

    entries = [entry(["dragon"], "@@dont_activate\nDragons hoard gold.")]
    assert fired(entries, said("A dragon.")) == ["Dragons hoard gold."]
    system = payload(make_character(card_rules=2), entries, said("A dragon."))["system"]
    assert "Dragons hoard gold." in system and "@@" not in system


def test_an_outlet_entry_is_never_inserted():
    entries = [entry(["dragon"], "Outlet.", position=7), entry([], "Outlet too.", constant=True, position=7),
               entry(["dragon"], "Inserted.", position=4)]
    assert fired(entries, said("A dragon.")) == ["Inserted."]


def test_a_key_naming_the_character_fires_on_any_of_its_turns():
    entries = [entry(["{{char}}"], "About Ana."), entry(["{{user}}"], "About Alex.")]
    assert fired(entries, said("Hello.", "I wait by the door.")) == ["About Ana.", "About Alex."]
    assert fired(entries, said("Hello.")) == ["About Alex."]

    system = payload(make_character(name="Ana", card_rules=2), entries,
                     said("Hello.", "I wait by the door."))["system"]
    assert "About Ana." in system


def test_a_secondary_key_seen_in_an_earlier_pass_still_counts():
    entries = [entry(["door"], "A long hall."), entry(["hall"], "At its end, a key."),
               entry(["key"], "The key opens the vault.", selective=True,
                     secondary_keys=["lantern"], selective_logic=0)]
    assert fired(entries, said("I raise the lantern and open the door.")) == [
        "A long hall.", "At its end, a key.", "The key opens the vault."]

    # All of them: one said, one in the first pass, the key itself in the second.
    entries[2] = {**entries[2], "secondary_keys": ["lantern", "hall"], "selective_logic": 3}
    assert fired(entries, said("I raise the lantern and open the door.")) == [
        "A long hall.", "At its end, a key.", "The key opens the vault."]


def test_a_key_across_the_join_of_two_passes_is_seen():
    entries = [entry(["walk"], "gate opens."), entry(["the old\ngate"], "Across the join.")]
    assert fired(entries, said("I walk to the old")) == ["gate opens.", "Across the join."]

    # The character before a key, left behind by an earlier pass, still decides.
    entries = [entry(["walk"], "More."), entry(["ring"], "Never.")]
    assert fired(entries, said("I walk, bring?")) == ["More."]
    assert fired(entries, said("I walk,ring?")) == ["More.", "Never."]


def test_a_chained_lorebook_of_a_thousand_entries_takes_linear_time():
    entries = [entry([f"k{i}"], f"k{i + 1} " + "x" * 200) for i in range(1000)]
    start = time.perf_counter()
    found = match_lore(entries, said("k0"), rules=2, budget=10**9)
    assert len(found) == 1000
    assert time.perf_counter() - start < 5


def test_the_lorebook_has_a_quarter_of_the_prompt_budget():
    messages = said("Hello.")
    # 2049 - 512 - 200 leaves 1337 for the prompt, a quarter of it 334 tokens.
    fits = [entry([], costing(334, "a"), constant=True)]
    too_large = [entry([], costing(335, "b"), constant=True)]
    assert costing(334, "a") in payload(make_character(card_rules=2), fits, messages, context_size=2049)["system"]
    shut_out = payload(make_character(card_rules=2), too_large, messages, context_size=2049)
    assert "bbb" not in shut_out["system"] and shut_out["stats"]["lore_matched"] == 0

    # On a large context it is far more than the 800 tokens of the old rules, which keep them.
    large = [entry(["hello"], costing(900, "c"), constant=True)]
    assert costing(900, "c") in payload(make_character(card_rules=2), large, messages)["system"]
    assert "ccc" not in payload(make_character(card_rules=1), large, messages)["system"]


def test_under_the_budget_the_highest_order_goes_first_and_a_large_entry_is_skipped():
    entries = [entry(["dragon"], costing(5, "a"), insertion_order=10),
               entry(["dragon"], costing(8, "b"), insertion_order=50),
               entry(["dragon"], costing(20, "c"), insertion_order=30),
               entry(["dragon"], costing(2, "d"), insertion_order=5)]
    # 50 takes 8 of the 10 tokens, 30 and 10 no longer fit, 5 still does.
    assert fired(entries, said("A dragon."), budget=10) == [costing(2, "d"), costing(8, "b")]

    # Of two entries of the same order, the first in the lorebook goes first.
    tied = [entry(["dragon"], costing(6, "e")), entry(["dragon"], costing(6, "f"))]
    assert fired(tied, said("A dragon."), budget=10) == [costing(6, "e")]


def test_entries_are_placed_by_ascending_order_then_lorebook_order():
    entries = [entry(["dragon"], "First hundred.", insertion_order=100),
               entry(["dragon"], "Below zero.", insertion_order=-5),
               entry(["dragon"], "Second hundred.", insertion_order=100),
               entry(["dragon"], "Seven.", insertion_order=7),
               entry(["dragon"], "Hundred by default.")]
    placed = ["Below zero.", "Seven.", "First hundred.", "Second hundred.", "Hundred by default."]
    assert fired(entries, said("A dragon.")) == placed

    system = payload(make_character(card_rules=2), entries, said("A dragon."))["system"]
    assert "\n\n".join(placed) in system


def test_an_entry_placed_before_the_definition_comes_before_it():
    entries = [entry(["dragon"], "After, by default."),
               entry(["dragon"], "Before.", position=0),
               entry(["dragon"], "After, at the end.", position=2),
               entry(["dragon"], "At a depth.", position=4)]
    system = payload(make_character(card_rules=2), entries, said("A dragon."))["system"]
    assert system.startswith(
        "You are Serana in an endless immersive roleplay with Alex.\n\n"
        "### WORLD KNOWLEDGE (background)\nBefore.\n\n### ABOUT SERANA\n")
    # The entry at a depth is said in the story, not here.
    assert ("### WORLD KNOWLEDGE (relevant to the current scene)\n"
            "After, by default.\n\nAfter, at the end.\n\n") in system
    assert system.count("Before.") == 1 and "At a depth." not in system

    # A scenario has it before its own definition too.
    scenario = payload(make_character(card_rules=2, kind="scenario"), entries, said("A dragon."))["system"]
    assert "for Alex.\n\n### WORLD KNOWLEDGE (background)\nBefore.\n\n### SCENARIO\n" in scenario

    # On the old rules every entry stays where it was.
    old = payload(make_character(), entries, said("A dragon."))["system"]
    assert "(background)" not in old
    assert "(relevant to the current scene)\nAfter, by default.\n\nBefore.\n\n" in old


def test_an_entry_of_decorators_alone_adds_no_section():
    entries = [entry([], "@@depth 4", constant=True, position=0),
               entry(["dragon"], "@@activate\r\n  \n")]
    assert fired(entries, said("A dragon.")) == []

    system = payload(make_character(card_rules=2), entries, said("A dragon."))["system"]
    assert "WORLD KNOWLEDGE" not in system
    assert system.startswith(
        "You are Serana in an endless immersive roleplay with Alex.\n\n### ABOUT SERANA\n")


NOTE = "[Note for the story, not written by Alex: Remember the storm.]"
STORY = ("Hi.", "Hello.", "How are you?", "Fine.", "Good.")


def noted(depth, note="Remember the storm.", **overrides):
    """A card on the rules of community cards, with a note to the character at a depth."""
    return make_character(card_rules=2, character_note=note, character_note_depth=depth, **overrides)


def chat(character, messages, entries=(), connection=None, **arguments):
    return asdict(build_chat_payload(
        character=character, persona=PERSONA, conversation={"summary": ""}, messages=messages,
        connection=connection or make_connection(), lore_entries=list(entries), **arguments))


def contents(built):
    return [turn["content"] for turn in built["messages"]]


def test_a_note_at_depth_one_sits_just_before_the_newest_message():
    assert contents(chat(noted(1), said(*STORY))) == [
        "Hi.", "Hello.", "How are you?", "Fine.", f"{NOTE}\n\nGood."]
    # Between two of the player's turns, it opens the newest rather than ending the one before.
    unanswered = said("Hi.", "Hello.", "Are you there?") + [make_message("user", "Hello?", 3)]
    assert contents(chat(noted(1), unanswered)) == [
        "Hi.", "Hello.", "Are you there?", f"{NOTE}\n\nHello?"]


def test_a_note_with_no_depth_given_sits_at_depth_four():
    unset = make_character(card_rules=2, character_note="Remember the storm.")
    assert chat(unset, said(*STORY)) == chat(noted(4), said(*STORY))
    assert chat(noted(None), said(*STORY)) == chat(noted(4), said(*STORY))


def test_the_note_takes_its_room_from_the_story():
    # A long opening turn, so that the note's room is that turn and no other; no examples,
    # which a tight context would drop and so give room back.
    story = [make_message("user", costing(40, "a"), 0)] + said(*STORY)[1:]
    unnoted = make_character(card_rules=2, example_dialogues="")

    def sent(character, size, **arguments):
        return chat(character, story, connection=make_connection(context_size=size), **arguments)

    # The smallest context in which every turn fits, with nothing to spare: what the prompt
    # uses, the reply's room and the margin.
    size = (chat(unnoted, story)["stats"]["used_tokens"]
            + make_connection()["max_tokens"] + _BUDGET_MARGIN)
    plain = sent(unnoted, size)
    assert plain["stats"]["messages_included"] == 5
    assert sent(unnoted, size - 1)["stats"]["messages_included"] == 4

    built = sent(noted(1, example_dialogues=""), size)
    assert built["stats"]["messages_included"] == 4
    assert contents(built) == ["Hello.", "How are you?", "Fine.", f"{NOTE}\n\nGood."]
    # Left out, the note leaves the story its room.
    bare = sent(noted(1, example_dialogues=""), size, insertions=False)
    assert bare["stats"]["messages_included"] == 5 and bare["messages"] == plain["messages"]


def test_a_note_at_depth_two_sits_at_the_end_of_the_player_s_message_before_the_last_reply():
    assert contents(chat(noted(2), said(*STORY))) == [
        "Hi.", "Hello.", f"How are you?\n\n{NOTE}", "Fine.", "Good."]


def test_the_note_is_marked_as_not_the_player_s_and_the_guardrails_come_after_it():
    plain = chat(make_character(card_rules=2), said(*STORY))
    built = chat(noted(1, "[I agree that {{char}} leads.]"), said(*STORY))
    assert built["messages"][-1]["content"] == (
        "[Note for the story, not written by Alex: [I agree that Serana leads.]]\n\nGood.")
    # The guardrails stay in the closing block, which each provider sets after the last turn.
    assert built["post_history"] == plain["post_history"]
    assert "I agree" not in built["system"] + built["post_history"]


def test_a_note_at_depth_zero_opens_the_closing_block():
    pinned = [{"id": "f1", "content": "Serana fears fire.", "is_pinned": True, "source_position": 1}]
    rules = {"post_history_instructions": "Write in the present tense."}
    built = chat(noted(0, **rules), said(*STORY), memories=pinned)
    plain = chat(make_character(card_rules=2, **rules), said(*STORY), memories=pinned)
    assert plain["post_history"].startswith("Write in the present tense.\n\n[Still true,")
    assert built["post_history"] == f"{NOTE}\n\n{plain['post_history']}"
    assert built["messages"] == plain["messages"]


def test_a_note_deeper_than_the_story_goes_before_the_oldest_turn_sent():
    assert contents(chat(noted(10), said("Hi.", "Hello.", "How are you?"))) == [
        f"{NOTE}\n\nHi.", "Hello.", "How are you?"]
    # Of the turns sent: those the history limit leaves out are not counted.
    assert contents(chat(noted(10), said(*STORY), history_limit=3)) == [
        f"{NOTE}\n\nHow are you?", "Fine.", "Good."]


def test_with_no_message_from_the_player_the_note_opens_the_closing_block():
    greeting = [make_message("assistant", "Who are you?", 0)]
    plain = chat(make_character(card_rules=2), greeting)
    for depth in (1, 4):
        built = chat(noted(depth), greeting)
        assert built["messages"] == plain["messages"]
        assert built["post_history"] == f"{NOTE}\n\n{plain['post_history']}"
    # Nor with no message at all.
    assert chat(noted(2), [])["post_history"] == f"{NOTE}\n\n{plain['post_history']}"


def test_the_note_and_entries_at_one_depth_are_said_once_the_note_first():
    entries = [entry(["dragon"], "Dragons fly.", position=4, depth=1),
               entry(["dragon"], "Dragons burn.", position=4, depth=1, insertion_order=50),
               entry(["dragon"], "Dragons sleep.", position=4, depth=2)]
    built = chat(noted(1), said("Hi.", "Hello.", "A dragon."), entries)
    assert contents(built) == [
        "Hi.\n\n[Note for the story, not written by Alex: Dragons sleep.]",
        "Hello.",
        ("[Note for the story, not written by Alex: Remember the storm.\nDragons burn.\nDragons fly.]"
         "\n\nA dragon.")]
    assert "Dragons" not in built["system"]
    assert built["stats"]["lore_matched"] == 3


def test_no_message_is_ever_added_to_the_story():
    stories = [said(*STORY), said("Hi.", "Hello.", "How are you?", "Fine."),
               [make_message("assistant", "Who are you?", 0), make_message("assistant", "Well?", 1),
                make_message("user", "Alex.", 2), make_message("assistant", "Ah.", 3),
                make_message("assistant", "Sit.", 4)],
               [make_message("assistant", "Who are you?", 0)], []]
    entries = [entry([], "Always.", constant=True, position=4, depth=3)]
    for messages in stories:
        for fold in (False, True):
            plain = chat(make_character(card_rules=2), messages, fold_leading_assistant=fold)
            for depth in range(20):
                built = chat(noted(depth), messages, entries, fold_leading_assistant=fold)
                assert [t["role"] for t in built["messages"]] == [t["role"] for t in plain["messages"]]
                everything = "\n".join(contents(built)) + built["post_history"]
                assert everything.count("Remember the storm.") == 1
                assert everything.count("Always.") == 1


def test_the_ghostwriter_reads_no_note():
    entries = [entry([], "Always.", constant=True, position=4, depth=1)]

    def ghost(character):
        return asdict(build_impersonate_payload(
            character=character, persona=PERSONA, conversation={"summary": ""},
            messages=said(*STORY), connection=make_connection()))

    built = ghost(noted(1))
    assert built == ghost(make_character(card_rules=2))
    assert "Remember the storm." not in str(built)
    # The chat payload it is made from says neither the note nor an entry at a depth.
    bare = chat(noted(1), said(*STORY), entries, insertions=False)
    assert "Remember the storm." not in str(bare) and "Always." not in str(bare)


def test_continuing_a_reply_keeps_the_note_in_place():
    history = said("Hi.", "Hello.", "How are you?", "Fine, and") + [
        make_message("user", _CONTINUE_INSTRUCTION, 4)]
    # The reply being continued is left as it stopped, and the instruction still ends the turns.
    assert contents(chat(noted(1), history)) == [
        "Hi.", "Hello.", "How are you?", "Fine, and", f"{NOTE}\n\n{_CONTINUE_INSTRUCTION}"]
    assert contents(chat(noted(2), history)) == [
        "Hi.", "Hello.", f"How are you?\n\n{NOTE}", "Fine, and", _CONTINUE_INSTRUCTION]
