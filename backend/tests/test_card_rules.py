"""Which lorebook entries fire, on the rules of community cards (2) and on Evermind's own (1)."""

import time
from dataclasses import asdict

from app.prompting.engine import build_chat_payload, match_lore
from app.prompting.lorebook import key_matches, strip_decorators

from .conftest import PERSONA, make_character, make_connection, make_message


def entry(keys, content="Lore.", **settings):
    return {"keys": keys, "content": content, **settings}


def fired(entries, messages, **arguments):
    """The contents of the entries that fire on the rules of community cards."""
    found = match_lore(entries, messages, rules=2, char_name="Ana", user_name="Alex", **arguments)
    return [e["content"] for e in found]


def said(*texts):
    """A conversation in two voices: the person first, then the character, in turn."""
    return [make_message("user" if i % 2 == 0 else "assistant", text, i) for i, text in enumerate(texts)]


def payload(character, entries, messages):
    return asdict(build_chat_payload(
        character=character, persona=PERSONA, conversation={"summary": ""},
        messages=messages, connection=make_connection(), lore_entries=entries))


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

    before = payload(make_character(), plain, messages)
    assert payload(make_character(card_rules=1), with_settings, messages) == before
    assert payload(make_character(), with_settings, messages) == before
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
    assert key_matches("old ring", "the bold ringmaster", True)
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
