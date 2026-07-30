import aiosqlite

from .base import new_id, now_iso
from ..prompting import embeddings

_ALLOWED_KINDS = {"fact", "event", "relationship", "promise", "state"}


def to_out(row) -> dict:
    out = dict(row)
    out.pop("embedding", None)  # bytes are not JSON-serializable; never expose
    out["is_pinned"] = bool(out["is_pinned"])
    return out


async def list_for_conversation(db: aiosqlite.Connection, convo_id: str) -> list[dict]:
    rows = await (await db.execute(
        "SELECT * FROM memories WHERE conversation_id = ?"
        " ORDER BY is_pinned DESC, source_position ASC, created_at ASC",
        (convo_id,))).fetchall()
    return [to_out(r) for r in rows]


async def add(db: aiosqlite.Connection, convo_id: str, content: str,
              kind: str = "fact", source_position: int = 0,
              is_pinned: bool = False, source: str = "auto") -> dict | None:
    content = (content or "").strip()
    if not content:
        return None
    if kind not in _ALLOWED_KINDS:
        kind = "fact"
    # exact-content dedup within the conversation
    existing = await (await db.execute(
        "SELECT id FROM memories WHERE conversation_id = ? AND content = ?",
        (convo_id, content))).fetchone()
    if existing:
        return None
    vectors = await embeddings.embed([content], kind="passage")
    blob = embeddings.pack(vectors[0]) if vectors else None
    memory_id = new_id()
    await db.execute(
        "INSERT INTO memories (id, conversation_id, kind, content, source_position,"
        " is_pinned, source, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (memory_id, convo_id, kind, content, source_position,
         int(is_pinned), source, now_iso(), blob),
    )
    await db.commit()
    return await get(db, memory_id)


async def find_by_content(db: aiosqlite.Connection, convo_id: str,
                          content: str) -> dict | None:
    row = await (await db.execute(
        "SELECT * FROM memories WHERE conversation_id = ? AND content = ?",
        (convo_id, (content or "").strip()))).fetchone()
    return to_out(row) if row else None


async def get(db: aiosqlite.Connection, memory_id: str) -> dict | None:
    row = await (await db.execute(
        "SELECT * FROM memories WHERE id = ?", (memory_id,))).fetchone()
    return to_out(row) if row else None


async def update(db: aiosqlite.Connection, memory_id: str,
                 content: str | None = None, is_pinned: bool | None = None) -> dict | None:
    if not await get(db, memory_id):
        return None
    sets, params = [], []
    if content is not None and content.strip():
        new_content = content.strip()
        sets.append("content = ?")
        params.append(new_content)
        # the stored vector describes the OLD text now; recompute it (or NULL it
        # so the startup backfill re-fills it) — never leave a stale embedding
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
    """Facts with no vector yet, across all conversations (for backfill)."""
    rows = await (await db.execute(
        "SELECT id, content FROM memories WHERE embedding IS NULL")).fetchall()
    return [dict(r) for r in rows]


async def set_embedding(db: aiosqlite.Connection, memory_id: str, blob: bytes) -> None:
    await db.execute("UPDATE memories SET embedding = ? WHERE id = ?", (blob, memory_id))
    await db.commit()
