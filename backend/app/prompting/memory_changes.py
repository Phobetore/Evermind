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
MAX_CHECKPOINTS = 30  # per conversation: a cut older than the oldest has none to go back to
MAX_TURNS_PER_RUN = 40  # safety cap on turns fed to one extraction call


def _items(value: object) -> list:
    return value if isinstance(value, list) else []


def _kind(value: object) -> str:
    return value if isinstance(value, str) and value in ALLOWED_KINDS else "fact"


def _fact(fact: dict, **changed) -> dict:
    return {"id": fact["id"], "kind": fact["kind"], "content": fact["content"],
            "source_position": fact["source_position"], "is_pinned": bool(fact["is_pinned"]),
            "source": fact["source"], **changed}


def is_movable(fact: dict) -> bool:
    """Whether the model may correct, drop or merge a fact: it wrote it and nobody pinned
    it. What a person typed or pinned is left alone."""
    return not fact["is_pinned"] and fact["source"] == "auto"


def plan_cut(memory_position: int, summary: str, checkpoints: list[dict],
             facts: list[dict], cut: int, removal: bool = False) -> dict:
    """What a conversation remembers once its story ends with the turn at ``cut``: a
    removal from position p cuts at p - 1, a branch at the position of its message.

    ``checkpoints`` are what the memory held each time a summary was written: ``{"position",
    "summary", "memory_position", "facts"}``, the summary as it stood once the turns up to
    ``position`` had been read, how far the facts had been read then, and a copy of the
    facts the model had written, ``{"id", "kind", "content", "source_position"}``.
    ``facts`` are what it holds now, each with ``is_pinned`` and ``source`` as well.

    The checkpoints after the cut go. When the memory had read past the cut, or when the
    summary is one written after it (a summary asked for describes the turns up to the last
    message without the facts having been read as far), the memory goes back to the newest
    checkpoint at or before the cut: the summary is that one's, the next pass reads from
    how far it had read, at the usual cost, and the model's facts become its copy. A later
    pass may have corrected or dropped one of them, and only the copy still has it. What
    the copy does not hold goes, whatever its position says.

    Without a checkpoint at or before the cut, the model's facts drawn from later turns go;
    a fact's position is the newest turn of the pass that drew it, so it goes with them even
    if the turn it came from stays. Nothing says how far the memory had read, so it goes back
    to the start, and the next pass draws again what it can from the newest turns, at the
    price of that one pass. This is for a conversation from before there were checkpoints, or
    a cut older than the oldest one kept. The summary is emptied only if that pass can write
    it again, when what is left of the story fits in what a pass reads. Otherwise it stays:
    part stale, which a person can read and correct, is better than a long story reduced to
    its last turns; and with no checkpoint left to compare it with, it reads as typed until
    the next pass.

    What a person typed or pinned is theirs, whatever the memory goes back to: it stays as
    it is, and a copy of it, or of what it says, is not restored beside it. If it was
    drawn from turns past the cut, a removal keeps it at the cut, since it is the only copy
    there is and the prompt must not place it at a turn that no longer exists, and a branch
    leaves it with the conversation it came from.

    A summary that is not the newest checkpoint's (after stripping) is treated as typed by
    a person, in a box that is theirs to edit: it stays, as a fact they wrote does. No
    checkpoint keeps it: a pass rewrites from the current summary, so what was typed lives on
    inside what the pass writes, and a cut back past that pass goes to a summary without it.

    ``{"memory_position": n, "summary": str, "checkpoints": [positions kept], "facts": [what
    the conversation holds now, as ``facts`` gives them]}``.
    """
    ordered = sorted(checkpoints, key=lambda c: c["position"])
    kept = [c for c in ordered if c["position"] <= cut]
    chosen = kept[-1] if kept else None
    newest = ordered[-1] if ordered else None
    typed = summary.strip() != (newest["summary"].strip() if newest else "")
    summary_is_ahead = not typed and newest is not None and newest["position"] > cut

    theirs = [f for f in facts if not is_movable(f)]
    stays = [_fact(f, source_position=max(cut, 0)) if f["source_position"] > cut else _fact(f)
             for f in theirs if removal or f["source_position"] <= cut]
    models = [_fact(f) for f in facts if is_movable(f) and f["source_position"] <= cut]
    result = {"memory_position": memory_position, "summary": summary,
              "checkpoints": [c["position"] for c in kept], "facts": stays + models}
    if memory_position <= cut and not summary_is_ahead:
        return result

    result["memory_position"] = (min(memory_position, chosen["memory_position"])
                                 if chosen is not None else 0)
    if not typed and chosen is not None:
        result["summary"] = chosen["summary"]
    elif not typed and cut + 1 <= MAX_TURNS_PER_RUN:
        result["summary"] = ""
    if chosen is not None and result["memory_position"] < memory_position:
        their_ids = {f["id"] for f in theirs}
        said = {f["content"] for f in stays}
        result["facts"] = stays + [
            _fact({**c, "is_pinned": False, "source": "auto"}) for c in chosen["facts"]
            if c["id"] not in their_ids and c["content"] not in said]
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
