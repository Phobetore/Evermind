"""What a model's answer changes in the memory of a conversation: the facts to add,
to correct and to drop, and the summary to keep, decided from the answer alone; and what
a cut in the story leaves of that memory.

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


def plan_cut(memory_position: int, summary: str, checkpoints: list[dict],
             facts: list[dict], cut: int) -> dict:
    """What a conversation remembers once its story ends with the turn at ``cut``: a
    removal from position p cuts at p - 1, a branch at the position of its message.

    ``checkpoints`` are what the passes left: ``{"position", "summary",
    "memory_position"}``, the running summary as it stood when the turns up to
    ``position`` had been read, and how far the facts had been read then. ``facts`` are
    ``{"id", "source_position", "is_pinned", "source"}``.

    The facts that the model drew from turns after the cut go; a fact's position is the
    newest turn of the pass that drew it, so it goes with them even if the turn it came
    from stays, and the next pass draws it again. What a person typed or pinned stays,
    whatever its position, since only they take it away.

    The checkpoints after the cut go. The memory goes back to the newest one at or before
    it, with its summary: the facts were read as far as it says, so the next pass reads
    from there, at the usual cost, and the summary is true of the story as it now is.
    That happens when the memory had read past the cut, or when the summary is the one
    written after it (a summary asked for describes the turns up to the last message
    without the facts having been read as far). Without a checkpoint at or before the
    cut the memory has read nothing it can vouch for: it goes back to the newest turn
    that a fact it keeps was drawn from, which a pinned fact does not count for, since it
    survives cuts and can carry the position of a story that is gone, or to the start; and
    the summary is emptied.

    A summary that is not the newest checkpoint's (after stripping) was typed by a person,
    in a box that is theirs to edit: it stays, as a fact they wrote does.

    ``{"memory_position": n, "summary": str, "checkpoints": [positions kept],
    "facts": [ids kept]}``.
    """
    kept_facts = [f for f in facts if not is_movable(f) or f["source_position"] <= cut]
    ordered = sorted(checkpoints, key=lambda c: c["position"])
    kept = [c for c in ordered if c["position"] <= cut]
    chosen = kept[-1] if kept else None
    newest = ordered[-1] if ordered else None
    typed = summary.strip() != (newest["summary"].strip() if newest else "")
    summary_is_ahead = not typed and newest is not None and newest["position"] > cut
    result = {"memory_position": memory_position, "summary": summary,
              "checkpoints": [c["position"] for c in kept],
              "facts": [f["id"] for f in kept_facts]}
    if memory_position <= cut and not summary_is_ahead:
        return result

    if chosen is not None:
        reached = chosen["memory_position"]
    else:
        reached = max((f["source_position"] for f in kept_facts if is_movable(f)), default=0)
    result["memory_position"] = min(memory_position, reached)
    if not typed:
        result["summary"] = chosen["summary"] if chosen is not None else ""
    return result


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
