import aiosqlite

from . import lore as lore_repo
from .base import dumps, loads, new_id, now_iso

_JSON_FIELDS = ("alternate_greetings", "tags")
_TEXT_FIELDS = (
    "kind", "name", "tagline", "description", "personality", "scenario", "greeting",
    "example_dialogues", "system_prompt", "post_history_instructions", "creator_notes",
    "creator", "character_version",
)


def to_out(row) -> dict:
    out = dict(row)
    for f in _JSON_FIELDS:
        out[f] = loads(out.get(f), [])
    avatar = out.pop("avatar_path", None)
    out["avatar_url"] = f"api/media/{avatar}" if avatar else None
    out["is_favorite"] = bool(out.get("is_favorite"))
    return out


async def create(db: aiosqlite.Connection, fields: dict) -> dict:
    char_id = new_id()
    now = now_iso()
    values = {f: fields.get(f) or "" for f in _TEXT_FIELDS}
    values["kind"] = values["kind"] or "character"
    await db.execute(
        f"""INSERT INTO characters (id, {", ".join(_TEXT_FIELDS)}, alternate_greetings, tags,
            avatar_path, created_at, updated_at)
            VALUES (?, {", ".join("?" for _ in _TEXT_FIELDS)}, ?, ?, ?, ?, ?)""",
        (char_id, *[values[f] for f in _TEXT_FIELDS],
         dumps([str(g) for g in fields.get("alternate_greetings") or []]),
         dumps([str(t) for t in fields.get("tags") or []]),
         fields.get("avatar_path"), now, now),
    )
    await lore_repo.replace(db, char_id, fields.get("lore_entries") or [])
    await db.commit()
    return await get(db, char_id)


async def get(db: aiosqlite.Connection, char_id: str) -> dict | None:
    row = await (await db.execute("SELECT * FROM characters WHERE id = ?", (char_id,))).fetchone()
    return to_out(row) if row else None


async def list_all(db: aiosqlite.Connection) -> list[dict]:
    rows = await (await db.execute(
        "SELECT * FROM characters ORDER BY is_favorite DESC, updated_at DESC")).fetchall()
    return [to_out(r) for r in rows]


async def update(db: aiosqlite.Connection, char_id: str, fields: dict) -> dict | None:
    if not await get(db, char_id):
        return None
    sets, params = [], []
    for key, value in fields.items():
        if value is None:
            continue
        if key in _JSON_FIELDS:
            sets.append(f"{key} = ?")
            params.append(dumps([str(x) for x in value]))
        elif key in _TEXT_FIELDS or key == "avatar_path":
            sets.append(f"{key} = ?")
            params.append(value)
        elif key == "is_favorite":
            sets.append("is_favorite = ?")
            params.append(int(bool(value)))
    if sets != ["is_favorite = ?"]:  # a favourite is no edit: the card keeps its place
        sets.append("updated_at = ?")
        params.append(now_iso())
    params.append(char_id)
    await db.execute(f"UPDATE characters SET {', '.join(sets)} WHERE id = ?", params)
    if fields.get("lore_entries") is not None:
        await lore_repo.replace(db, char_id, fields["lore_entries"])
    await db.commit()
    return await get(db, char_id)


async def delete(db: aiosqlite.Connection, char_id: str) -> bool:
    cursor = await db.execute("DELETE FROM characters WHERE id = ?", (char_id,))
    await db.commit()
    return cursor.rowcount > 0
