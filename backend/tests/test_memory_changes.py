"""What plan_memory_changes returns is pinned by cases/memory_changes.json; here,
what it leaves alone."""

import copy

from app.prompting.memory_changes import plan_memory_changes

EXISTING = [
    {"id": "1", "content": "Pinned fact.", "is_pinned": True, "source": "auto"},
    {"id": "2", "content": "Old one.", "is_pinned": False, "source": "auto"},
    {"id": "3", "content": "Hand fact.", "is_pinned": False, "source": "user"},
]
ANSWER = {
    "facts": [{"content": "Fresh.", "kind": "event"}],
    "updated_facts": [{"replaces": "Old one.", "content": "Old one, corrected."},
                      {"replaces": "Fresh.", "content": "Fresh, corrected."}],
    "obsolete_facts": ["Old one, corrected.", "Hand fact."],
    "summary": " Summed up. ",
}


def test_planning_leaves_the_facts_as_they_were():
    existing = copy.deepcopy(EXISTING)

    plan = plan_memory_changes(ANSWER, existing, 9)

    assert existing == EXISTING
    # What it did decide, so that the test is about an answer that changes things.
    assert (plan["add"], plan["update"], plan["delete"]) == (
        [{"content": "Fresh, corrected.", "kind": "event", "source_position": 9}], {}, ["2"])
