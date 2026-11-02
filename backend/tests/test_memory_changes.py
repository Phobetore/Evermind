"""What plan_memory_changes returns is pinned by parity/memory_changes.json; here,
what it leaves alone."""

import copy

from app.prompting.memory_changes import plan_consolidation, plan_memory_changes

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


def test_planning_leaves_the_facts_and_the_answer_as_they_were():
    existing, answer = copy.deepcopy(EXISTING), copy.deepcopy(ANSWER)

    plan = plan_memory_changes(answer, existing, 9)

    assert existing == EXISTING
    assert answer == ANSWER
    # What it did decide, so that the test is about an answer that changes things.
    assert [op["op"] for op in plan["ops"]] == ["add", "update", "update", "delete"]


def test_planning_a_consolidation_leaves_the_answer_and_the_facts_as_they_were():
    answer = {"facts": [{"content": " One. "}, {"content": "Two.", "kind": "event"}]}
    movable = [{"source_position": 5}, {"source_position": 2}]
    before = copy.deepcopy((answer, movable))

    plan = plan_consolidation(answer, movable)

    assert (answer, movable) == before
    assert plan == {"facts": [{"content": "One.", "kind": "fact"},
                              {"content": "Two.", "kind": "event"}], "source_position": 2}
