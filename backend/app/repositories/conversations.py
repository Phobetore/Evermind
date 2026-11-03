import aiosqlite

from ..prompting.memory_changes import plan_cut
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
    fork_point = await get_message(db, message_id)
    if not fork_point:
        return None
    source = await get(db, fork_point["conversation_id"], with_messages=False)
    if not source:
        return None
    position = fork_point["position"]

    branch_id = new_id()
    now = now_iso()
    title = (source.get("title") or "Sans titre")[:52] + " (branche)"
    # What the memory holds of a story that ends at the fork: the summary may describe
    # events past it, and the facts may be drawn from them.
    mem_rows = await (await db.execute(
        "SELECT * FROM memories WHERE conversation_id = ?", (source["id"],))).fetchall()
    checkpoints = await list_checkpoints(db, source["id"])
    remembered = plan_cut(source.get("memory_position") or 0, source.get("summary") or "",
                          checkpoints, [dict(row) for row in mem_rows], position)
    memory_position = remembered["memory_position"]
    summary = remembered["summary"]
    kept_facts = set(remembered["facts"])
    # Read raw rather than off `source`, which has already turned the stored
    # filename into a URL for the client.
    backdrop = await (await db.execute(
        "SELECT wallpaper_path, wallpaper_opacity FROM conversations WHERE id = ?",
        (source["id"],))).fetchone()

    # The backdrop follows, like the persona and the connection: a branch is the
    # same scene carried on differently, and losing the picture behind it would
    # read as something having gone wrong rather than as a fresh start. The
    # file is shared, not copied, which is why removing one never deletes it.
    await db.execute(
        "INSERT INTO conversations (id, character_id, persona_id, connection_id, title,"
        " summary, author_note, memory_position, forked_from, forked_at_position,"
        " wallpaper_path, wallpaper_opacity, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (branch_id, source["character_id"], source.get("persona_id"),
         source.get("connection_id"), title, summary,
         # The scene directive is the strongest lever there is on a reply, and
         # it was the one piece of the setup a branch dropped.
         source.get("author_note") or "", memory_position,
         source["id"], position, backdrop["wallpaper_path"],
         backdrop["wallpaper_opacity"], now, now),
    )

    rows = await (await db.execute(
        "SELECT * FROM messages WHERE conversation_id = ? AND position <= ?"
        " ORDER BY position ASC", (source["id"], position))).fetchall()
    for row in rows:
        await db.execute(
            "INSERT INTO messages (id, conversation_id, role, variants, active_index,"
            " position, meta, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (new_id(), branch_id, row["role"], row["variants"], row["active_index"],
             row["position"], _meta_for_branch(row["meta"]), row["created_at"], row["embedding"]),
        )

    for row in mem_rows:
        if row["id"] not in kept_facts:
            continue
        await db.execute(
            "INSERT INTO memories (id, conversation_id, kind, content, source_position,"
            " is_pinned, source, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (new_id(), branch_id, row["kind"], row["content"], row["source_position"],
             row["is_pinned"], row["source"], row["created_at"], row["embedding"]),
        )
    for checkpoint in checkpoints:
        if checkpoint["position"] in remembered["checkpoints"]:
            await db.execute(
                "INSERT INTO memory_checkpoints (conversation_id, position, summary,"
                " memory_position) VALUES (?, ?, ?, ?)",
                (branch_id, checkpoint["position"], checkpoint["summary"],
                 checkpoint["memory_position"]))

    await db.commit()
    return await get(db, branch_id)


async def list_checkpoints(db: aiosqlite.Connection, convo_id: str) -> list[dict]:
    """What the passes left, oldest first: the summary as it stood once the turns up to
    ``position`` were read, and how far the facts had been read then."""
    rows = await (await db.execute(
        "SELECT position, summary, memory_position FROM memory_checkpoints"
        " WHERE conversation_id = ? ORDER BY position ASC", (convo_id,))).fetchall()
    return [dict(row) for row in rows]


async def checkpoint(db: aiosqlite.Connection, convo_id: str, message: dict) -> None:
    """Record the summary that the conversation holds now as the one for the story up to
    ``message``, with how far the facts have been read. A pass calls it once it has
    written its summary and position; a summary asked for, once it has written its own,
    which has read turns without drawing facts from them. Written only while the message
    is there: a checkpoint for a turn that was removed meanwhile would outlive the story
    it describes. Does not commit."""
    await db.execute(
        "INSERT OR REPLACE INTO memory_checkpoints"
        " (conversation_id, position, summary, memory_position)"
        " SELECT id, ?, summary, memory_position FROM conversations"
        " WHERE id = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ?)",
        (message["position"], convo_id, message["id"]))


async def _rewind_memory(db: aiosqlite.Connection, convo_id: str, cut: int) -> None:
    """Take what a conversation remembers back to a story that now ends with the turn
    at ``cut`` (see ``plan_cut``). Positions are reused by the messages that come next,
    so a memory left as it was would wait for them to pass the old mark before reading
    anything, would keep as canon what was drawn from turns that no longer exist, and
    would describe them in its summary.

    Does not commit: it belongs to the removal that calls it."""
    row = await (await db.execute(
        "SELECT memory_position, summary FROM conversations WHERE id = ?",
        (convo_id,))).fetchone()
    facts = await (await db.execute(
        "SELECT id, source_position, is_pinned, source FROM memories WHERE conversation_id = ?",
        (convo_id,))).fetchall()
    checkpoints = await list_checkpoints(db, convo_id)
    read = row["memory_position"] or 0
    remembered = plan_cut(read, row["summary"] or "", checkpoints,
                          [dict(fact) for fact in facts], cut)
    if remembered["memory_position"] != read or remembered["summary"] != row["summary"]:
        await db.execute("UPDATE conversations SET memory_position = ?, summary = ? WHERE id = ?",
                         (remembered["memory_position"], remembered["summary"], convo_id))
    await db.executemany(
        "DELETE FROM memory_checkpoints WHERE conversation_id = ? AND position = ?",
        [(convo_id, c["position"]) for c in checkpoints
         if c["position"] not in remembered["checkpoints"]])
    kept_facts = set(remembered["facts"])
    await db.executemany(
        "DELETE FROM memories WHERE id = ?",
        [(fact["id"],) for fact in facts if fact["id"] not in kept_facts])


async def delete_message(db: aiosqlite.Connection, message_id: str,
                         following: bool = False) -> bool:
    """Remove a message, or with ``following`` the story from it on, which takes the
    memory back with it. One message alone leaves a hole and no cut: nothing says
    which fact it gave rise to."""
    message = await get_message(db, message_id)
    if not message:
        return False
    if following:
        await db.execute(
            "DELETE FROM messages WHERE conversation_id = ? AND position >= ?",
            (message["conversation_id"], message["position"]),
        )
        await _rewind_memory(db, message["conversation_id"], message["position"] - 1)
    else:
        await db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
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
