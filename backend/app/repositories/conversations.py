import aiosqlite

from ..db import write_transaction
from ..prompting.memory_changes import MAX_TURNS_PER_RUN
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
    out["wallpaper_url"] = f"api/media/{wallpaper}" if wallpaper else None
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
    if fields.get("summary") is not None:
        await _type_summary(db, convo_id, fields["summary"], fields.get("summary_was"))
    sets, params = [], []
    for key in ("title", "author_note", "persona_id", "connection_id",
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


async def turns_through(db: aiosqlite.Connection, convo_id: str,
                        position: int) -> list[tuple[str, str]]:
    """The story up to a position, in order: each message's id and what it says."""
    rows = await (await db.execute(
        "SELECT id, variants, active_index FROM messages WHERE conversation_id = ? AND position <= ?"
        " ORDER BY position ASC", (convo_id, position))).fetchall()
    return [(m["id"], m["content"]) for m in map(message_to_out, rows)]


async def next_position(db: aiosqlite.Connection, convo_id: str) -> int:
    row = await (await db.execute(
        "SELECT COALESCE(MAX(position), -1) AS p FROM messages WHERE conversation_id = ?",
        (convo_id,))).fetchone()
    return row["p"] + 1


async def add_message(db: aiosqlite.Connection, convo_id: str, role: str,
                      variants: list[str], active_index: int = 0,
                      meta: dict | None = None, message_id: str | None = None) -> dict:
    message_id = message_id or new_id()
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
    """New conversation replaying the story up to (and including) a message, with what its
    memory held of that story: a cut at the message (see ``_rewind_memory``)."""
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
        # The backdrop follows, like the persona and the connection: a branch is the
        # same scene carried on differently, and losing the picture behind it would
        # read as something having gone wrong rather than as a fresh start.
        await db.execute(
            "INSERT INTO conversations (id, character_id, persona_id, connection_id, title,"
            " summary, author_note, memory_position, forked_from, forked_at_position,"
            " wallpaper_path, wallpaper_opacity, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (branch_id, source["character_id"], source["persona_id"],
             source["connection_id"], title, source["summary"],
             # The scene directive is the strongest lever there is on a reply, and
             # it was the one piece of the setup a branch dropped.
             source["author_note"] or "", source["memory_position"],
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
        # What a person kept from after the fork stays with the story it came from.
        facts = await (await db.execute(
            "SELECT * FROM memories WHERE conversation_id = ? AND source_position <= ?",
            (source["id"], position))).fetchall()
        await db.executemany(
            "INSERT INTO memories (id, conversation_id, content, source_position, is_pinned,"
            " source, created_at, embedding, previous_content, corrected_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(new_id(), branch_id, f["content"], f["source_position"], f["is_pinned"],
              f["source"], f["created_at"], f["embedding"], f["previous_content"],
              f["corrected_at"]) for f in facts])
        await db.execute(
            "INSERT INTO memory_summaries (conversation_id, position, summary, typed)"
            " SELECT ?, position, summary, typed FROM memory_summaries WHERE conversation_id = ?",
            (branch_id, source["id"]))
        await _rewind_memory(db, branch_id, position, branch=True)

    return await get(db, branch_id)


# A conversation's newest summary row is where its memory has read to, and holds its summary.
async def _type_summary(db: aiosqlite.Connection, convo_id: str, summary: str,
                        was: str | None) -> None:
    """A summary a person saved, kept as theirs where the memory had read to when they typed over
    ``was``: a cut back there gives it back, and the turns a pass read since are read again."""
    async with write_transaction(db):
        row = await (await db.execute(
            "SELECT memory_position, summary FROM conversations WHERE id = ?", (convo_id,))).fetchone()
        if not row or row["summary"] == summary:
            return
        over = row["summary"] if was is None else was
        base = await (await db.execute(
            "SELECT position, typed FROM memory_summaries WHERE conversation_id = ? AND summary = ?"
            " ORDER BY position DESC LIMIT 1", (convo_id, over))).fetchone()
        position = base["position"] if base else 0
        # Over a summary of turns past its row, or over one no row holds now: it may tell them too.
        ahead = base["typed"] == 2 if base else bool(over or row["summary"])
        await db.execute("DELETE FROM memory_summaries WHERE conversation_id = ? AND position > ?",
                         (convo_id, position))
        await db.execute(
            "INSERT OR REPLACE INTO memory_summaries (conversation_id, position, summary, typed)"
            " VALUES (?, ?, ?, ?)", (convo_id, position, summary, 2 if ahead else 1))
        await db.execute("UPDATE conversations SET summary = ?, memory_position = ? WHERE id = ?",
                         (summary, position, convo_id))


async def remember(db: aiosqlite.Connection, convo_id: str, position: int,
                   summary: str | None) -> None:
    """What a pass wrote of the story up to ``position``. A pass that wrote no summary keeps the
    one there was, typed (1) if a person's. Does not commit: it belongs to what it records."""
    newest = await (await db.execute(
        "SELECT typed FROM memory_summaries WHERE conversation_id = ? ORDER BY position DESC LIMIT 1",
        (convo_id,))).fetchone()
    await db.execute(
        "INSERT OR REPLACE INTO memory_summaries (conversation_id, position, summary, typed)"
        " SELECT id, ?, COALESCE(?, summary), ? FROM conversations WHERE id = ?",
        (position, summary, summary is None and bool(newest and newest["typed"]), convo_id))
    await db.execute(
        "UPDATE conversations SET memory_position = ?, summary = COALESCE(?, summary),"
        " updated_at = ? WHERE id = ?",
        (position, summary, now_iso(), convo_id))


async def _rewind_memory(db: aiosqlite.Connection, convo_id: str, cut: int,
                         branch: bool = False) -> None:
    """Take what a conversation remembers back to a story that now ends with the turn at
    ``cut``, as the last pass at or before it left it: the model's later facts go, its later
    corrections are undone, and what a person wrote, pinned or typed stays. Does not commit."""
    await db.execute(
        "DELETE FROM memories WHERE conversation_id = ? AND source = 'auto' AND is_pinned = 0"
        " AND source_position > ?", (convo_id, cut))
    await db.execute(
        "UPDATE memories SET content = previous_content, previous_content = NULL,"
        " corrected_at = NULL, embedding = NULL WHERE conversation_id = ? AND source = 'auto'"
        " AND is_pinned = 0 AND corrected_at > ?", (convo_id, cut))
    # A fact kept as it is: no later cut puts back what a correction from turns now gone replaced.
    await db.execute(
        "UPDATE memories SET previous_content = NULL, corrected_at = NULL WHERE conversation_id = ?"
        " AND corrected_at > ?", (convo_id, cut))
    await db.execute(
        "UPDATE memories SET source_position = ? WHERE conversation_id = ? AND source_position > ?",
        (max(cut, 0), convo_id, cut))
    row = await (await db.execute(
        "SELECT memory_position, summary FROM conversations WHERE id = ?", (convo_id,))).fetchone()
    passes = await (await db.execute(
        "SELECT position, summary, typed FROM memory_summaries WHERE conversation_id = ?"
        " ORDER BY position DESC", (convo_id,))).fetchall()
    # A branch takes no summary typed at 0 or of turns past its row: it may tell later turns.
    back = next((p for p in passes if p["position"] <= cut and not (
        branch and (p["typed"] == 2 or (p["typed"] and p["position"] == 0)))), None)
    if row["memory_position"] <= cut and (back or not branch):
        return
    position = back["position"] if back else 0
    await db.execute("DELETE FROM memory_summaries WHERE conversation_id = ? AND position > ?",
                     (convo_id, position if back else -1))
    if branch:  # what the memory had at the message, and nothing of what came after it
        summary = back["summary"] if back else ""
    elif passes and passes[0]["typed"]:  # what a person wrote stays theirs, part stale
        summary = row["summary"]
        if not back or back["summary"] != summary:  # typed over a later row: of turns past this one
            await db.execute(
                "INSERT OR REPLACE INTO memory_summaries (conversation_id, position, summary, typed)"
                " VALUES (?, ?, ?, 2)", (convo_id, position, summary))
    elif back:
        summary = back["summary"]
    elif cut + 1 <= MAX_TURNS_PER_RUN:  # the next pass reads all that is left of the story
        summary = ""
    else:
        summary = row["summary"]
    await db.execute("UPDATE conversations SET memory_position = ?, summary = ? WHERE id = ?",
                     (position, summary, convo_id))


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


async def set_message_embedding(db: aiosqlite.Connection, message_id: str, blob: bytes) -> bool:
    """Store a message's vector. Whether the message is still there."""
    cursor = await db.execute("UPDATE messages SET embedding = ? WHERE id = ?", (blob, message_id))
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
    """Messages with no vector yet (for fill_vectors). Carries variants/active_index
    so the caller can embed the ACTIVE content."""
    rows = await (await db.execute(
        "SELECT id, variants, active_index FROM messages WHERE embedding IS NULL")).fetchall()
    out = []
    for r in rows:
        out.append({"id": r["id"], "variants": loads(r["variants"], [""]),
                    "active_index": r["active_index"] or 0})
    return out
