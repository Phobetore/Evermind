"""What a model's answer changes in the memory of a conversation: the facts to add,
to correct and to drop, and the summary to keep, decided from the answer alone.

Pure: no database, no model. The callers read what these functions read, and apply what they return.

Only a string is text. A ``content`` or a ``replaces`` that is a number,
a list or ``null`` is absent, where ``str()`` of it used to be saved as a memory
("12", "['a']"); and what is not a list is no list, where a string used to be read
letter by letter. A string that cannot be written (a lone surrogate) is absent too:
it would fail in the database, after the changes before it were saved.
"""

from .text import text_of

MAX_TURNS_PER_RUN = 40  # safety cap on turns fed to one extraction call


def _items(value: object) -> list:
    return value if isinstance(value, list) else []


def is_movable(fact: dict) -> bool:
    """Whether the model may correct, drop or merge a fact: it wrote it and nobody pinned
    it. What a person typed or pinned is left alone."""
    return not fact["is_pinned"] and fact["source"] == "auto"


def answer_texts(parsed: dict) -> list[str]:
    """Every text that the changes of an extraction's answer can write."""
    items = _items(parsed.get("facts")) + _items(parsed.get("updated_facts"))
    return [text for item in items if isinstance(item, dict) and (text := text_of(item.get("content")))]


def plan_memory_changes(parsed: dict, existing: list[dict], top_position: int) -> dict:
    """The changes an extraction's answer makes to ``existing``, the facts as they are, each with
    its ``id``. Each change is decided on what the ones before it leave, so the answer can correct
    or drop a fact it adds; a text reaches the first fact of ``existing`` that says it. The model
    corrects or drops only a fact it wrote and nobody pinned, adds nothing in place of the others,
    and drops a fact it corrects into another fact's text. ``{"add": [{"content",
    "source_position"}], "update": {id: content}, "delete": [id], "summary": str | None}``,
    applied deletes, then updates, then adds, so an add never repeats what a fact says."""
    known = [{"id": m["id"], "content": m["content"], "movable": is_movable(m)} for m in existing]
    adds: list[dict] = []
    updates: dict[str, str] = {}
    deletes: list[str] = []

    def add(content: str) -> None:
        if not content or any(m["content"] == content for m in known):
            return
        new = {"content": content, "source_position": top_position}
        adds.append(new)
        known.append({"added": new, "content": content, "movable": True})

    def find(text: object) -> dict | None:
        wanted = text_of(text)
        return next((m for m in known if m["content"] == wanted), None)

    def correct(fact: dict, content: str) -> None:
        fact["content"] = content
        if "added" in fact:
            fact["added"]["content"] = content
        else:
            updates[fact["id"]] = content

    def drop(fact: dict) -> None:
        known[:] = [m for m in known if m is not fact]
        if "added" in fact:
            adds[:] = [a for a in adds if a is not fact["added"]]
        else:
            updates.pop(fact["id"], None)
            deletes.append(fact["id"])

    for fact in _items(parsed.get("facts")):
        if isinstance(fact, dict):
            add(text_of(fact.get("content")))

    # Corrections and merges.
    for update in _items(parsed.get("updated_facts")):
        new_content = text_of(update.get("content")) if isinstance(update, dict) else ""
        if not new_content:
            continue
        target = find(update.get("replaces"))
        if target is None:
            add(new_content)
        elif target["movable"]:
            if any(m is not target and m["content"] == new_content for m in known):
                drop(target)
            else:
                correct(target, new_content)

    for obsolete in _items(parsed.get("obsolete_facts")):
        target = find(obsolete)
        if target and target["movable"]:
            drop(target)

    return {"add": adds, "update": updates, "delete": deletes,
            "summary": text_of(parsed.get("summary")) or None}


def plan_consolidation(parsed: dict | None, movable: list[dict]) -> dict | None:
    """The facts that replace ``movable`` once the model has merged them, or None
    when its answer holds none that can be read. The merged facts take the oldest
    position of the ones they replace: consolidation makes long-term memory, and a
    recent position would make the engine treat it as covered by the visible
    history and mute it for dozens of turns.

    Two of them may say the same thing: adding them is what drops the second."""
    facts = [text for item in _items((parsed or {}).get("facts"))
             if isinstance(item, dict) and (text := text_of(item.get("content")))]
    if not facts:
        return None
    return {"facts": facts,
            "source_position": min((m["source_position"] for m in movable), default=0)}
