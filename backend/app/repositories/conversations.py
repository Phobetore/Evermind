from collections import defaultdict

import aiosqlite

from ..db import write_transaction
from ..prompting.memory_changes import MAX_CHECKPOINTS, plan_cut
from . import characters as characters_repo
from .base import dumps, loads, new_id, now_iso


def message_to_out(row) -> dict:
    out = dict(row)
    out.pop("embedding", None)  # bytes are not JSON-serializable; never expose
    out["variants"] = loads(out.get("variants"), [""])
    out["meta"] = loads(out.get("meta"), {})
    index = out.get("active_index") or 0
    if not 0 <= index < len(out["variants"]):
        index = len(out["variants"]) - 1
        out["active_index"] = index
    out["content"] = out["variants"][index]
    return out


def convo_to_out(row) -> dict:
    out = dict(row)
    wallpaper = out.pop("wallpaper_path", None)
    out["wallpaper_url"] = f"/api/media/{wallpaper}" if wallpaper else None
    return out


async def create(db: aiosqlite.Connection, fields: dict) -> dict | None:
    convo_id = new_id()
    now = now_iso()
    await db.execute(
        "INSERT INTO conversations (id, character_id, persona_id, connection_id, title, summary,"
        " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (convo_id, fields["character_id"], fields.get("persona_id"),
         fields.get("connection_id"), fields.get("title") or "", "", now, now),
    )
    await db.commit()
    return await get(db, convo_id)


async def get(db: aiosqlite.Connection, convo_id: str, with_messages: bool = True) -> dict | None:
    row = await (await db.execute(
        "SELECT * FROM conversations WHERE id = ?", (convo_id,))).fetchone()
    if not row:
        return None
    convo = convo_to_out(row)
    convo["character"] = await characters_repo.get(db, convo["character_id"])
    if with_messages:
        convo["messages"] = await list_messages(db, convo_id)
    return convo


async def list_all(db: aiosqlite.Connection, character_id: str | None = None) -> list[dict]:
    sql = (
        "SELECT c.*, COUNT(m.id) AS message_count, MAX(m.created_at) AS last_message_at"
        " FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id"
    )
    params: list = []
    if character_id:
        sql += " WHERE c.character_id = ?"
        params.append(character_id)
    sql += " GROUP BY c.id ORDER BY COALESCE(MAX(m.created_at), c.updated_at) DESC"
    rows = await (await db.execute(sql, params)).fetchall()
    out = []
    for row in rows:
        convo = convo_to_out(row)
        convo["character"] = await characters_repo.get(db, convo["character_id"])
        out.append(convo)
    return out


async def update(db: aiosqlite.Connection, convo_id: str, fields: dict) -> dict | None:
    if not await (await db.execute(
            "SELECT id FROM conversations WHERE id = ?", (convo_id,))).fetchone():
        return None
    sets, params = [], []
    for key in ("title", "summary", "author_note", "persona_id", "connection_id",
                "wallpaper_path", "wallpaper_opacity"):
        if key in fields and fields[key] is not None:
            sets.append(f"{key} = ?")
            params.append(fields[key])
    sets.append("updated_at = ?")
    params.append(now_iso())
    params.append(convo_id)
    await db.execute(f"UPDATE conversations SET {', '.join(sets)} WHERE id = ?", params)
    await db.commit()
    return await get(db, convo_id, with_messages=False)


async def touch(db: aiosqlite.Connection, convo_id: str) -> None:
    await db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?",
                     (now_iso(), convo_id))
    await db.commit()


async def delete(db: aiosqlite.Connection, convo_id: str) -> bool:
    cursor = await db.execute("DELETE FROM conversations WHERE id = ?", (convo_id,))
    await db.commit()
    return cursor.rowcount > 0


# ---------- messages ----------

async def list_messages(db: aiosqlite.Connection, convo_id: str) -> list[dict]:
    rows = await (await db.execute(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY position ASC",
        (convo_id,))).fetchall()
    return [message_to_out(r) for r in rows]


async def message_ids_through(db: aiosqlite.Connection, convo_id: str, position: int) -> list[str]:
    """The messages of the story up to a position, in order, by id."""
    rows = await (await db.execute(
        "SELECT id FROM messages WHERE conversation_id = ? AND position <= ?"
        " ORDER BY position ASC", (convo_id, position))).fetchall()
    return [r["id"] for r in rows]


async def next_position(db: aiosqlite.Connection, convo_id: str) -> int:
    row = await (await db.execute(
        "SELECT COALESCE(MAX(position), -1) AS p FROM messages WHERE conversation_id = ?",
        (convo_id,))).fetchone()
    return row["p"] + 1


async def add_message(db: aiosqlite.Connection, convo_id: str, role: str,
                      variants: list[str], active_index: int = 0,
                      meta: dict | None = None) -> dict:
    message_id = new_id()
    position = await next_position(db, convo_id)
    await db.execute(
        "INSERT INTO messages (id, conversation_id, role, variants, active_index, position,"
        " meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (message_id, convo_id, role, dumps(variants), active_index, position,
         dumps(meta or {}), now_iso()),
    )
    await db.commit()
    return await get_message(db, message_id)


async def get_message(db: aiosqlite.Connection, message_id: str) -> dict | None:
    row = await (await db.execute(
        "SELECT * FROM messages WHERE id = ?", (message_id,))).fetchone()
    return message_to_out(row) if row else None


async def update_message(db: aiosqlite.Connection, message_id: str,
                         variants: list[str] | None = None,
                         active_index: int | None = None,
                         meta: dict | None = None) -> dict | None:
    current = await get_message(db, message_id)
    if not current:
        return None
    sets, params = [], []
    if variants is not None:
        sets.append("variants = ?")
        params.append(dumps(variants))
    if active_index is not None:
        sets.append("active_index = ?")
        params.append(active_index)
    if meta is not None:
        sets.append("meta = ?")
        params.append(dumps(meta))
    if variants is not None or active_index is not None:
        sets.append("embedding = ?")
        params.append(None)  # active content may have changed -> re-embed lazily
    if sets:
        params.append(message_id)
        await db.execute(f"UPDATE messages SET {', '.join(sets)} WHERE id = ?", params)
        await db.commit()
    return await get_message(db, message_id)


def _meta_for_branch(raw: str | None) -> str:
    """A message's mark as still waiting for a reply says something about the turn
    that was asked for in the conversation it comes from, not about a branch, where
    ending on that message is what the person has just chosen. So does the id it was
    sent under: nothing was sent to the branch."""
    meta = loads(raw, {})
    meta.pop("unanswered", None)
    meta.pop("client_id", None)
    return dumps(meta)


async def branch_from_message(db: aiosqlite.Connection, message_id: str) -> dict | None:
    """New conversation replaying the story up to (and including) a message.
    Memories and summary follow only if they were established by then."""
    async with write_transaction(db):
        fork_point = await get_message(db, message_id)
        if not fork_point:
            return None
        source = await (await db.execute(
            "SELECT * FROM conversations WHERE id = ?", (fork_point["conversation_id"],))).fetchone()
        if not source:
            return None
        position = fork_point["position"]

        branch_id = new_id()
        now = now_iso()
        title = (source["title"] or "Sans titre")[:52] + " (branche)"
        # What the memory holds of a story that ends at the fork: the summary may describe
        # events past it, and the facts may be drawn from them.
        rows = {row["id"]: row for row in await (await db.execute(
            "SELECT * FROM memories WHERE conversation_id = ?", (source["id"],))).fetchall()}
        checkpoints = await list_checkpoints(db, source["id"])
        remembered = plan_cut(source["memory_position"] or 0, source["summary"] or "",
                              checkpoints, [dict(row) for row in rows.values()], position)

        # The backdrop follows, like the persona and the connection: a branch is the
        # same scene carried on differently, and losing the picture behind it would
        # read as something having gone wrong rather than as a fresh start.
        await db.execute(
            "INSERT INTO conversations (id, character_id, persona_id, connection_id, title,"
            " summary, author_note, memory_position, forked_from, forked_at_position,"
            " wallpaper_path, wallpaper_opacity, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (branch_id, source["character_id"], source["persona_id"],
             source["connection_id"], title, remembered["summary"],
             # The scene directive is the strongest lever there is on a reply, and
             # it was the one piece of the setup a branch dropped.
             source["author_note"] or "", remembered["memory_position"],
             source["id"], position, source["wallpaper_path"],
             source["wallpaper_opacity"], now, now),
        )

        messages = await (await db.execute(
            "SELECT * FROM messages WHERE conversation_id = ? AND position <= ?"
            " ORDER BY position ASC", (source["id"], position))).fetchall()
        # One statement: a long story, one await at a time, holds the database for seconds.
        await db.executemany(
            "INSERT INTO messages (id, conversation_id, role, variants, active_index,"
            " position, meta, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(new_id(), branch_id, row["role"], row["variants"], row["active_index"],
              row["position"], _meta_for_branch(row["meta"]), row["created_at"], row["embedding"])
             for row in messages],
        )

        # A fact has one new name in the branch, in its list and in every copy that holds
        # it, so that what a person does to it there reaches them all and nothing else.
        renamed = defaultdict(new_id)
        for fact in remembered["facts"]:
            was = rows.get(fact["id"])
            await db.execute(
                "INSERT INTO memories (id, conversation_id, kind, content, source_position,"
                " is_pinned, source, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (renamed[fact["id"]], branch_id, fact["kind"], fact["content"],
                 fact["source_position"], int(fact["is_pinned"]), fact["source"],
                 was["created_at"] if was else now,
                 was["embedding"] if was and was["content"] == fact["content"] else None),
            )
        for checkpoint_ in checkpoints:
            if checkpoint_["position"] not in remembered["checkpoints"]:
                continue
            await db.execute(
                "INSERT INTO memory_checkpoints (conversation_id, position, summary,"
                " memory_position) VALUES (?, ?, ?, ?)",
                (branch_id, checkpoint_["position"], checkpoint_["summary"],
                 checkpoint_["memory_position"]))
            await db.executemany(
                "INSERT INTO memory_checkpoint_facts (conversation_id, position, fact_id, kind,"
                " content, source_position) VALUES (?, ?, ?, ?, ?, ?)",
                [(branch_id, checkpoint_["position"], renamed[f["id"]], f["kind"], f["content"],
                  f["source_position"]) for f in checkpoint_["facts"]])

    return await get(db, branch_id)


async def list_checkpoints(db: aiosqlite.Connection, convo_id: str) -> list[dict]:
    """What the memory held each time a pass ended, whether or not it wrote a summary,
    oldest first: the summary it had written once the turns up to ``position`` were read,
    how far the facts had been read then, and a copy of the facts the model had written."""
    rows = await (await db.execute(
        "SELECT position, summary, memory_position FROM memory_checkpoints"
        " WHERE conversation_id = ? ORDER BY position ASC", (convo_id,))).fetchall()
    copies = await (await db.execute(
        "SELECT position, fact_id, kind, content, source_position FROM memory_checkpoint_facts"
        " WHERE conversation_id = ? ORDER BY position ASC, rowid ASC", (convo_id,))).fetchall()
    facts = defaultdict(list)
    for copy in copies:
        facts[copy["position"]].append(
            {"id": copy["fact_id"], "kind": copy["kind"], "content": copy["content"],
             "source_position": copy["source_position"]})
    return [{**dict(row), "facts": facts[row["position"]]} for row in rows]


async def remember(db: aiosqlite.Connection, convo_id: str, position: int,
                   summary: str | None) -> None:
    """What a pass wrote of the story up to ``position``: the conversation says so, and
    a checkpoint keeps it. Does not commit: it belongs to what it records."""
    await db.execute(
        "UPDATE conversations SET memory_position = ?, summary = COALESCE(?, summary),"
        " updated_at = ? WHERE id = ?",
        (position, summary, now_iso(), convo_id))
    await checkpoint(db, convo_id, position, summary)


async def checkpoint(db: aiosqlite.Connection, convo_id: str, position: int,
                     summary: str | None) -> None:
    """Record what the memory holds now as what it held for the story up to ``position``,
    with how far the conversation says the facts have been read.

    ``summary`` is what was written. None, a pass that wrote none, gives the one the
    last checkpoint has, and not the one the conversation holds, which a person may have
    typed: it would then look like the model's, and a cut would take it away.

    Every fact the model wrote is copied, pinned or not: one that is pinned now may not be
    at the cut, and the next pass will not read it again. Only the newest checkpoints stay.

    Does not commit: it belongs to what it records."""
    if summary is None:
        last = await (await db.execute(
            "SELECT summary FROM memory_checkpoints WHERE conversation_id = ?"
            " ORDER BY position DESC LIMIT 1", (convo_id,))).fetchone()
        summary = last["summary"] if last else ""
    await db.execute("DELETE FROM memory_checkpoints WHERE conversation_id = ? AND position = ?",
                     (convo_id, position))
    await db.execute(
        "INSERT INTO memory_checkpoints (conversation_id, position, summary, memory_position)"
        " SELECT id, ?, ?, memory_position FROM conversations WHERE id = ?",
        (position, summary, convo_id))
    await db.execute(
        "INSERT INTO memory_checkpoint_facts (conversation_id, position, fact_id, kind, content,"
        " source_position) SELECT conversation_id, ?, id, kind, content, source_position"
        " FROM memories WHERE conversation_id = ? AND source = 'auto'",
        (position, convo_id))
    await db.execute(
        "DELETE FROM memory_checkpoints WHERE conversation_id = ? AND position NOT IN ("
        " SELECT position FROM memory_checkpoints WHERE conversation_id = ?"
        " ORDER BY position DESC LIMIT ?)",
        (convo_id, convo_id, MAX_CHECKPOINTS))


async def _rewind_memory(db: aiosqlite.Connection, convo_id: str, cut: int) -> None:
    """Take what a conversation remembers back to a story that now ends with the turn
    at ``cut`` (see ``plan_cut``). Positions are reused by the messages that come next,
    so a memory left as it was would wait for them to pass the old mark before reading
    anything, would keep as canon what was drawn from turns that no longer exist, and
    would describe them in its summary.

    A fact that comes back keeps its id, which is what the copies name it by. It keeps its
    vector only if it says what the vector was worked out from; otherwise it has none,
    and the backfill gives it one.

    Does not commit: it belongs to the removal that calls it."""
    row = await (await db.execute(
        "SELECT memory_position, summary FROM conversations WHERE id = ?",
        (convo_id,))).fetchone()
    held = {fact["id"]: fact for fact in await (await db.execute(
        "SELECT id, kind, content, source_position, is_pinned, source FROM memories"
        " WHERE conversation_id = ?", (convo_id,))).fetchall()}
    checkpoints = await list_checkpoints(db, convo_id)
    read = row["memory_position"] or 0
    remembered = plan_cut(read, row["summary"] or "", checkpoints,
                          [dict(fact) for fact in held.values()], cut, removal=True)
    if remembered["memory_position"] != read or remembered["summary"] != row["summary"]:
        await db.execute("UPDATE conversations SET memory_position = ?, summary = ? WHERE id = ?",
                         (remembered["memory_position"], remembered["summary"], convo_id))
    await db.executemany(
        "DELETE FROM memory_checkpoints WHERE conversation_id = ? AND position = ?",
        [(convo_id, c["position"]) for c in checkpoints
         if c["position"] not in remembered["checkpoints"]])
    planned = {fact["id"]: fact for fact in remembered["facts"]}
    await db.executemany("DELETE FROM memories WHERE id = ?",
                         [(fact_id,) for fact_id in held if fact_id not in planned])
    for fact_id, fact in planned.items():
        was = held.get(fact_id)
        if was is None:
            await db.execute(
                "INSERT INTO memories (id, conversation_id, kind, content, source_position,"
                " is_pinned, source, created_at) VALUES (?, ?, ?, ?, ?, 0, 'auto', ?)",
                (fact_id, convo_id, fact["kind"], fact["content"], fact["source_position"],
                 now_iso()))
        elif any(was[key] != fact[key] for key in ("kind", "content", "source_position")):
            # The right-hand sides read the row as it was.
            await db.execute(
                "UPDATE memories SET embedding = CASE WHEN content = ? THEN embedding END,"
                " kind = ?, content = ?, source_position = ? WHERE id = ?",
                (fact["content"], fact["kind"], fact["content"], fact["source_position"], fact_id))


async def delete_message(db: aiosqlite.Connection, message_id: str) -> bool:
    """Remove the story from this message on. The memory goes back to before it: nothing
    says what was drawn from it, or from the turns that were read with it in the story,
    and the next pass reads again those that stay."""
    message = await get_message(db, message_id)
    if not message:
        return False
    await db.execute(
        "DELETE FROM messages WHERE conversation_id = ? AND position >= ?",
        (message["conversation_id"], message["position"]),
    )
    await _rewind_memory(db, message["conversation_id"], message["position"] - 1)
    await db.commit()
    return True


async def set_message_embedding(db: aiosqlite.Connection, message_id: str, content: str,
                                blob: bytes) -> bool:
    """Store the vector worked out for ``content``, unless the message says something
    else by now: working one out takes a while, and the message can be edited, or
    another variant chosen, meanwhile. Whether it was stored.

    A message's text is its active variant, so it is read as the interface reads it,
    and the write is guarded by the columns that text was read from."""
    row = await (await db.execute(
        "SELECT variants, active_index FROM messages WHERE id = ?", (message_id,))).fetchone()
    if row is None or message_to_out(row)["content"] != content:
        return False
    cursor = await db.execute(
        "UPDATE messages SET embedding = ? WHERE id = ? AND variants IS ? AND active_index IS ?",
        (blob, message_id, row["variants"], row["active_index"]))
    await db.commit()
    return cursor.rowcount > 0


async def list_message_embeddings(db: aiosqlite.Connection, convo_id: str) -> dict[str, bytes]:
    """{message_id: blob} for this conversation's messages that carry a vector."""
    rows = await (await db.execute(
        "SELECT id, embedding FROM messages"
        " WHERE conversation_id = ? AND embedding IS NOT NULL",
        (convo_id,))).fetchall()
    return {r["id"]: r["embedding"] for r in rows}


async def list_messages_missing_embeddings(db: aiosqlite.Connection) -> list[dict]:
    """Messages with no vector yet (for backfill). Carries variants/active_index
    so the caller can embed the ACTIVE content."""
    rows = await (await db.execute(
        "SELECT id, variants, active_index FROM messages WHERE embedding IS NULL")).fetchall()
    out = []
    for r in rows:
        out.append({"id": r["id"], "variants": loads(r["variants"], [""]),
                    "active_index": r["active_index"] or 0})
    return out
