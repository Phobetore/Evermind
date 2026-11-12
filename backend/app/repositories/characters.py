import aiosqlite

from . import lore as lore_repo
from .base import dumps, loads, new_id, now_iso

_JSON_FIELDS = ("alternate_greetings", "tags")
_TEXT_FIELDS = (
    "kind", "name", "tagline", "description", "personality", "scenario", "greeting",
    "example_dialogues", "system_prompt", "post_history_instructions", "creator_notes",
    "creator", "character_version", "nickname", "character_note", "character_note_role",
)
_INT_FIELDS = ("card_rules", "character_note_depth")
# What a column holds when a caller leaves it out, where an empty text would not do.
_DEFAULTS = {"kind": "character", "character_note_role": "system", "card_rules": 1,
             "character_note_depth": 4}

# The card file is never read here: it can weigh megabytes, and a list would carry them all.
_SELECT = """SELECT characters.*, EXISTS(SELECT 1 FROM character_cards AS card
             WHERE card.character_id = characters.id) AS has_card FROM characters"""


def to_out(row) -> dict:
    out = dict(row)
    for f in _JSON_FIELDS:
        out[f] = loads(out.get(f), [])
    out["creator_notes_multilingual"] = loads(out.get("creator_notes_multilingual"), {})
    avatar = out.pop("avatar_path", None)
    out["avatar_url"] = f"api/media/{avatar}" if avatar else None
    out["is_favorite"] = bool(out.get("is_favorite"))
    out["has_card"] = bool(out.get("has_card"))
    return out


def _stored(fields: dict) -> dict:
    """The fields of a new character as its columns hold them."""
    values = {f: fields.get(f) or _DEFAULTS.get(f, "") for f in _TEXT_FIELDS}
    values.update({f: _DEFAULTS[f] if fields.get(f) is None else int(fields[f])
                   for f in _INT_FIELDS})
    values.update({f: [str(x) for x in fields.get(f) or []] for f in _JSON_FIELDS})
    values["creator_notes_multilingual"] = dict(fields.get("creator_notes_multilingual") or {})
    return values


def _reading(read: dict) -> dict:
    """What the reader made of a card, through the rules its fields were stored by: a character
    nobody has touched since equals it, and its entries are those the server kept."""
    stored = {**read, **_stored(read), "lore_entries": lore_repo.clean(read.get("lore_entries") or [])}
    stored.pop("card", None)
    return stored


async def _keep_card(db: aiosqlite.Connection, char_id: str, card: dict) -> None:
    """Writes the card file beside the character, in place of any it had. Does not commit."""
    await db.execute(
        "INSERT INTO character_cards (character_id, text, format, read, other_text, read_at)"
        " VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(character_id) DO UPDATE SET text = excluded.text,"
        " format = excluded.format, read = excluded.read, other_text = excluded.other_text,"
        " read_at = excluded.read_at",
        (char_id, card["text"], card["format"], dumps(_reading(card["read"])),
         card.get("other_text"), now_iso()),
    )


async def create(db: aiosqlite.Connection, fields: dict) -> dict:
    char_id = new_id()
    now = now_iso()
    values = _stored(fields)
    columns = (*_TEXT_FIELDS, *_INT_FIELDS, *_JSON_FIELDS, "creator_notes_multilingual")
    await db.execute(
        f"""INSERT INTO characters (id, {", ".join(columns)}, avatar_path, created_at, updated_at)
            VALUES (?, {", ".join("?" for _ in columns)}, ?, ?, ?)""",
        (char_id, *[values[f] for f in (*_TEXT_FIELDS, *_INT_FIELDS)],
         *[dumps(values[f]) for f in (*_JSON_FIELDS, "creator_notes_multilingual")],
         fields.get("avatar_path"), now, now),
    )
    await lore_repo.replace(db, char_id, fields.get("lore_entries") or [])
    if fields.get("card"):
        await _keep_card(db, char_id, fields["card"])
    await db.commit()
    return await get(db, char_id)


async def get(db: aiosqlite.Connection, char_id: str) -> dict | None:
    row = await (await db.execute(f"{_SELECT} WHERE characters.id = ?", (char_id,))).fetchone()
    return to_out(row) if row else None


async def list_all(db: aiosqlite.Connection) -> list[dict]:
    rows = await (await db.execute(
        f"{_SELECT} ORDER BY is_favorite DESC, updated_at DESC")).fetchall()
    return [to_out(r) for r in rows]


async def get_card(db: aiosqlite.Connection, char_id: str) -> dict | None:
    row = await (await db.execute(
        "SELECT text, format, read, other_text, read_at FROM character_cards"
        " WHERE character_id = ?", (char_id,))).fetchone()
    if not row:
        return None
    return {**dict(row), "read": loads(row["read"], {})}


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
        elif key == "creator_notes_multilingual":
            sets.append(f"{key} = ?")
            params.append(dumps(dict(value)))
        elif key in _INT_FIELDS:
            sets.append(f"{key} = ?")
            params.append(int(value))
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
    if fields.get("card"):
        await _keep_card(db, char_id, fields["card"])
    await db.commit()
    return await get(db, char_id)


async def delete(db: aiosqlite.Connection, char_id: str) -> bool:
    cursor = await db.execute("DELETE FROM characters WHERE id = ?", (char_id,))
    await db.commit()
    return cursor.rowcount > 0
