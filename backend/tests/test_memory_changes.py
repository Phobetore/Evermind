"""What plan_memory_changes returns is pinned by cases/memory_changes.json; here,
what it leaves alone."""

import copy

from app.prompting.memory_changes import plan_cut, plan_memory_changes

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
    assert [op["op"] for op in plan["ops"]] == ["add", "update", "update", "delete"]


def test_planning_a_cut_leaves_what_it_reads_as_it_was():
    def given():
        return {
            "checkpoints": [
                {"position": 8, "summary": "S8", "memory_position": 8, "facts": [
                    {"id": "a", "kind": "fact", "content": "As it was.", "source_position": 8}]},
                {"position": 16, "summary": "S16", "memory_position": 16, "facts": []}],
            "facts": [
                {"id": "a", "kind": "fact", "content": "Changed.", "source_position": 8,
                 "is_pinned": 0, "source": "auto"},
                {"id": "p", "kind": "fact", "content": "Pinned.", "source_position": 16,
                 "is_pinned": 1, "source": "auto"}]}

    read = given()

    plan = plan_cut(16, "S16", read["checkpoints"], read["facts"], 10, removal=True)

    assert read == given()
    # What it did decide, so that the test is about a cut that changes things.
    assert [(f["id"], f["content"], f["source_position"]) for f in plan["facts"]] == [
        ("p", "Pinned.", 10), ("a", "As it was.", 8)]
