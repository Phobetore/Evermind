"""What a model's answer changes in the memory of a conversation: the facts to add,
to correct and to drop, and the summary to keep, decided from the answer alone.

Pure, with no database and no model, so that frontend/src/engine/memoryChanges.ts
can answer the same cases (parity/memory_changes.json). The services read what
these read, and apply what they return through the repository.

Only a string is text. A ``content``, a ``kind`` or a ``replaces`` that is a number,
a list or ``null`` is absent, where ``str()`` of it used to be saved as a memory
("12", "['a']"); and what is not a list is no list, where a string used to be read
letter by letter. A string that cannot be written (a lone surrogate) is absent too:
it would fail in the database, after the changes before it were saved.
"""

from .text import text_of

ALLOWED_KINDS = {"fact", "event", "relationship", "promise", "state"}
MAX_CONSOLIDATED_FACTS = 30  # what one consolidation may leave of the model's merge


def _items(value: object) -> list:
    return value if isinstance(value, list) else []


def _kind(value: object) -> str:
    return value if isinstance(value, str) and value in ALLOWED_KINDS else "fact"


def is_movable(fact: dict) -> bool:
    """Whether the model may correct, drop or merge a fact: it wrote it and nobody pinned
    it. What a person typed or pinned is left alone."""
    return not fact["is_pinned"] and fact["source"] == "auto"


def survives_cut(fact: dict, cut: int, *, removal: bool = False) -> bool:
    """Whether a fact still holds in a story that now ends with the turn at ``cut``: it
    was drawn from turns up to there. A fact's position is the newest turn that its pass
    read, so one from a later pass goes even if the turn it was drawn from stays. A
    position of 0 is older than every turn, and stays while there is a turn left, but a
    cut at -1 leaves none.

    A branch is a copy: it carries what the turns up to its message established, and
    nothing else, a pinned fact included. A ``removal`` takes turns out of the one
    conversation, where only the model's facts go with them: what a person typed or
    pinned is theirs to take away."""
    if removal and not is_movable(fact):
        return True
    return fact["source_position"] <= cut


def memory_after_cut(memory_position: int, cut: int) -> dict:
    """Where the memory has read to once the story ends with the turn at ``cut``, and
    whether the summary still describes it: it does if the memory had not read past
    ``cut``. Otherwise the memory has read turns that are gone, and the summary may
    describe them. Making a new one is for the next pass, which has the turns to read.

    ``{"memory_position": n, "summary_holds": bool}``, with a position that is never
    negative: a cut at -1 takes the whole story, and the memory has read none of it."""
    if memory_position <= cut:
        return {"memory_position": memory_position, "summary_holds": True}
    return {"memory_position": max(cut, 0), "summary_holds": False}


def plan_memory_changes(parsed: dict, existing: list[dict], top_position: int) -> dict:
    """The changes that an extraction's answer makes, in the order they are applied:
    the facts it adds, then those it corrects, then those it drops.

    ``existing`` is what the conversation remembers. Each change is decided on
    what the ones before it leave, so that one can reach a fact that an earlier one
    added, and the result is what applying them one by one to the memory gives.
    Several facts can say the same thing, since a person may edit one into what
    another says: the first of ``existing`` is the one that a later correction or
    drop reaches, so ``existing`` comes in the order in which the repository looks
    a fact up (``memories_repo.list_in_lookup_order``).

    Only a fact that the model wrote and nobody pinned is for it to correct or drop:
    the model leaves alone what a person typed or pinned, and adds nothing in its place.
    A correction into the text of another fact drops the corrected one instead, since
    what it says is recorded already.

    ``{"ops": [...], "summary": ...}``. An op is ``{"op": "add", "content", "kind",
    "source_position", "source": "auto"}``, ``{"op": "update", "target", "content"}``
    (``target`` is what the fact says now) or ``{"op": "delete", "target"}``.
    ``summary`` is None when the answer holds none to keep.
    """
    known = [{"content": m["content"], "is_pinned": bool(m["is_pinned"]), "source": m["source"]}
             for m in existing]
    ops: list[dict] = []

    def add(content: str, kind: str) -> None:
        """What ``memories_repo.add`` does with a stripped text: nothing when it is
        empty or already said, and a fact that the next change may reach otherwise."""
        if not content or any(m["content"] == content for m in known):
            return
        known.append({"content": content, "is_pinned": False, "source": "auto"})
        ops.append({"op": "add", "content": content, "kind": kind,
                    "source_position": top_position, "source": "auto"})

    def find(text: object) -> dict | None:
        """What ``memories_repo.find_by_content`` finds."""
        wanted = text_of(text)
        return next((m for m in known if m["content"] == wanted), None)

    def drop(fact: dict) -> None:
        ops.append({"op": "delete", "target": fact["content"]})
        known[:] = [m for m in known if m is not fact]

    for fact in _items(parsed.get("facts")):
        if isinstance(fact, dict):
            add(text_of(fact.get("content")), _kind(fact.get("kind")))

    # Corrections and merges.
    for update in _items(parsed.get("updated_facts")):
        new_content = text_of(update.get("content")) if isinstance(update, dict) else ""
        if not new_content:
            continue
        target = find(update.get("replaces"))
        if target is None:
            add(new_content, "fact")
        elif is_movable(target):
            if any(m is not target and m["content"] == new_content for m in known):
                drop(target)
            else:
                ops.append({"op": "update", "target": target["content"], "content": new_content})
                target["content"] = new_content

    for obsolete in _items(parsed.get("obsolete_facts")):
        target = find(obsolete)
        if target and is_movable(target):
            drop(target)

    return {"ops": ops, "summary": text_of(parsed.get("summary")) or None}


def plan_consolidation(parsed: dict | None, movable: list[dict]) -> dict | None:
    """The facts that replace ``movable`` once the model has merged them, or None
    when its answer holds none that can be read. The merged facts take the oldest
    position of the ones they replace: consolidation makes long-term memory, and a
    recent position would make the engine treat it as covered by the visible
    history and mute it for dozens of turns.

    Two of them may say the same thing: adding them is what drops the second."""
    facts = []
    for item in _items((parsed or {}).get("facts")):
        if isinstance(item, dict) and text_of(item.get("content")):
            facts.append({"content": text_of(item["content"]), "kind": _kind(item.get("kind"))})
    if not facts:
        return None
    return {"facts": facts[:MAX_CONSOLIDATED_FACTS],
            "source_position": min((m["source_position"] for m in movable), default=0)}
