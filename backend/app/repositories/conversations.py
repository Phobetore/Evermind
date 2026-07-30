import aiosqlite

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
    return dict(row)


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
    for key in ("title", "summary", "author_note", "persona_id", "connection_id"):
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


async def last_message(db: aiosqlite.Connection, convo_id: str) -> dict | None:
    row = await (await db.execute(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY position DESC LIMIT 1",
        (convo_id,))).fetchone()
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
    summary = source.get("summary") or ""
    memory_position = min(source.get("memory_position") or 0, position)
    if memory_position < (source.get("memory_position") or 0):
        # the summary may describe events past the fork; drop it rather than lie
        summary = ""
    await db.execute(
        "INSERT INTO conversations (id, character_id, persona_id, connection_id, title,"
        " summary, memory_position, forked_from, forked_at_position, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (branch_id, source["character_id"], source.get("persona_id"),
         source.get("connection_id"), title, summary, memory_position,
         source["id"], position, now, now),
    )

    rows = await (await db.execute(
        "SELECT * FROM messages WHERE conversation_id = ? AND position <= ?"
        " ORDER BY position ASC", (source["id"], position))).fetchall()
    for row in rows:
        await db.execute(
            "INSERT INTO messages (id, conversation_id, role, variants, active_index,"
            " position, meta, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (new_id(), branch_id, row["role"], row["variants"], row["active_index"],
             row["position"], row["meta"], row["created_at"], row["embedding"]),
        )

    mem_rows = await (await db.execute(
        "SELECT * FROM memories WHERE conversation_id = ? AND source_position <= ?",
        (source["id"], position))).fetchall()
    for row in mem_rows:
        await db.execute(
            "INSERT INTO memories (id, conversation_id, kind, content, source_position,"
            " is_pinned, source, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (new_id(), branch_id, row["kind"], row["content"], row["source_position"],
             row["is_pinned"], row["source"], row["created_at"], row["embedding"]),
        )

    await db.commit()
    return await get(db, branch_id)


async def delete_message(db: aiosqlite.Connection, message_id: str,
                         following: bool = False) -> bool:
    message = await get_message(db, message_id)
    if not message:
        return False
    if following:
        await db.execute(
            "DELETE FROM messages WHERE conversation_id = ? AND position >= ?",
            (message["conversation_id"], message["position"]),
        )
    else:
        await db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
    await db.commit()
    return True


async def set_message_embedding(db: aiosqlite.Connection, message_id: str, blob: bytes) -> None:
    await db.execute("UPDATE messages SET embedding = ? WHERE id = ?", (blob, message_id))
    await db.commit()


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
