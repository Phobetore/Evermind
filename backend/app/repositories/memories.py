import aiosqlite

from ..prompting import embeddings
from .base import new_id, now_iso


def to_out(row) -> dict:
    out = dict(row)
    out.pop("embedding", None)  # bytes are not JSON-serializable; never expose
    out["is_pinned"] = bool(out["is_pinned"])
    return out


async def list_for_conversation(db: aiosqlite.Connection, convo_id: str) -> list[dict]:
    rows = await (await db.execute(
        "SELECT * FROM memories WHERE conversation_id = ?"
        " ORDER BY is_pinned DESC, source_position ASC, created_at ASC, rowid ASC",
        (convo_id,))).fetchall()
    return [to_out(r) for r in rows]


async def _says(db: aiosqlite.Connection, convo_id: str, content: str) -> bool:
    """Exact-content dedup within the conversation."""
    return await (await db.execute(
        "SELECT id FROM memories WHERE conversation_id = ? AND content = ?",
        (convo_id, content))).fetchone() is not None


async def add(db: aiosqlite.Connection, convo_id: str, content: str,
              source_position: int = 0, is_pinned: bool = False,
              source: str = "auto") -> dict | None:
    """A new fact, or None for a text said already. What a person writes that only the model has
    said makes the model's fact theirs."""
    content = (content or "").strip()
    if not content:
        return None
    said = await (await db.execute(
        "SELECT id, source FROM memories WHERE conversation_id = ? AND content = ?"
        " ORDER BY source = 'user' DESC LIMIT 1", (convo_id, content))).fetchone()
    if said:
        if source != "user" or said["source"] == "user":
            return None
        # Unless a pass corrected or dropped it since: theirs is then a fact of its own.
        made_theirs = await db.execute(
            "UPDATE memories SET source = 'user', is_pinned = MAX(is_pinned, ?), previous_content = NULL,"
            " corrected_at = NULL WHERE id = ? AND content = ?", (int(is_pinned), said["id"], content))
        await db.commit()
        if made_theirs.rowcount:
            return await get(db, said["id"])
    vectors = await embeddings.embed([content], kind="passage")
    saved = await add_with_vector(db, convo_id, content, source_position,
                                  embeddings.pack(vectors[0]) if vectors else None,
                                  is_pinned=is_pinned, source=source)
    await db.commit()
    return saved


async def add_with_vector(db: aiosqlite.Connection, convo_id: str, content: str,
                          source_position: int, blob: bytes | None, *,
                          is_pinned: bool = False, source: str = "auto") -> dict | None:
    """``add`` for what is written with other things: the vector was worked out before, and
    the caller commits. None for a text that is said already."""
    if await _says(db, convo_id, content):
        return None
    memory_id = new_id()
    await db.execute(
        "INSERT INTO memories (id, conversation_id, content, source_position,"
        " is_pinned, source, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (memory_id, convo_id, content, source_position, int(is_pinned), source, now_iso(), blob),
    )
    return await get(db, memory_id)


async def get(db: aiosqlite.Connection, memory_id: str) -> dict | None:
    row = await (await db.execute(
        "SELECT * FROM memories WHERE id = ?", (memory_id,))).fetchone()
    return to_out(row) if row else None


async def update(db: aiosqlite.Connection, memory_id: str,
                 content: str | None = None, is_pinned: bool | None = None) -> dict | None:
    """What a person changes in a fact. What they write is theirs: cuts and passes leave it as
    they would a fact they wrote."""
    if not await get(db, memory_id):
        return None
    sets, params = [], []
    if content is not None and content.strip():
        new_content = content.strip()
        sets += ["content = ?", "source = 'user'", "previous_content = NULL", "corrected_at = NULL"]
        params.append(new_content)
        # the stored vector describes the OLD text now; recompute it (or NULL it
        # so that the next start fills it) — never leave a stale embedding
        vectors = await embeddings.embed([new_content], kind="passage")
        sets.append("embedding = ?")
        params.append(embeddings.pack(vectors[0]) if vectors else None)
    if is_pinned is not None:
        sets.append("is_pinned = ?")
        params.append(int(is_pinned))
    if sets:
        params.append(memory_id)
        await db.execute(f"UPDATE memories SET {', '.join(sets)} WHERE id = ?", params)
        await db.commit()
    return await get(db, memory_id)


async def rewrite(db: aiosqlite.Connection, memory_id: str, content: str,
                  blob: bytes | None, at: int) -> None:
    """The model corrects a fact, in a pass that read up to ``at``: what it said is kept, for
    a cut back before that pass to restore. A fact it restates word for word keeps its vector,
    and what it said before an earlier correction. The caller commits."""
    await db.execute(
        "UPDATE memories SET previous_content = content, corrected_at = ?, content = ?,"
        " embedding = ? WHERE id = ? AND content <> ?", (at, content, blob, memory_id, content))


async def remove(db: aiosqlite.Connection, memory_id: str) -> None:
    """The model drops or merges a fact. The caller commits."""
    await db.execute("DELETE FROM memories WHERE id = ?", (memory_id,))


async def delete(db: aiosqlite.Connection, memory_id: str) -> bool:
    cursor = await db.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    await db.commit()
    return cursor.rowcount > 0


async def list_embeddings(db: aiosqlite.Connection, convo_id: str) -> dict[str, bytes]:
    """{memory_id: blob} for facts of this conversation that carry a vector."""
    rows = await (await db.execute(
        "SELECT id, embedding FROM memories"
        " WHERE conversation_id = ? AND embedding IS NOT NULL",
        (convo_id,))).fetchall()
    return {r["id"]: r["embedding"] for r in rows}


async def list_missing_embeddings(db: aiosqlite.Connection) -> list[dict]:
    """Facts with no vector yet, across all conversations (for fill_vectors)."""
    rows = await (await db.execute(
        "SELECT id, content FROM memories WHERE embedding IS NULL")).fetchall()
    return [dict(r) for r in rows]


async def set_embedding(db: aiosqlite.Connection, memory_id: str, content: str,
                        blob: bytes) -> bool:
    """Store the vector worked out for ``content``, unless the fact says something else
    by now: working one out takes a while, and the fact can be rewritten meanwhile.
    Whether it was stored."""
    cursor = await db.execute(
        "UPDATE memories SET embedding = ? WHERE id = ? AND content = ?",
        (blob, memory_id, content))
    await db.commit()
    return cursor.rowcount > 0
