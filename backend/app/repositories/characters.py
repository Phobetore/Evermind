import asyncio
from typing import Literal

import aiosqlite

from ..db import write_transaction
from ..models.schemas import CharacterIn
from ..services import card_text
from . import lore as lore_repo
from .base import dumps, loads, new_id, now_iso

_JSON_FIELDS = ("alternate_greetings", "tags")
_TEXT_FIELDS = (
    "kind", "name", "tagline", "description", "personality", "scenario", "greeting",
    "example_dialogues", "system_prompt", "post_history_instructions", "creator_notes",
    "creator", "character_version", "nickname", "character_note", "character_note_role",
)
_INT_FIELDS = ("card_rules", "character_note_depth")
# What a column holds when a caller leaves it out, where an empty text would not do: taken from
# the request's own defaults, so a character made here and one sent by a page cannot drift apart.
_DEFAULTS = {
    name: CharacterIn.model_fields[name].default
    for name in ("kind", "character_note_role", "card_rules", "character_note_depth")
}

# The card file is never read here: it can weigh megabytes, and a list would carry them all.
_SELECT = """SELECT characters.*, EXISTS(SELECT 1 FROM character_cards AS card
             WHERE card.character_id = characters.id) AS has_card FROM characters"""


def to_out(row) -> dict:
    out = dict(row)
    for f in _JSON_FIELDS:
        out[f] = loads(out.get(f), [])
    out["creator_notes_multilingual"] = loads(out.get("creator_notes_multilingual"), {})
    for column, url in (("avatar_path", "avatar_url"), ("avatar_thumb_path", "avatar_thumb_url"),
                        ("avatar_backdrop_path", "avatar_backdrop_url")):
        name = out.pop(column, None)
        out[url] = f"api/media/{name}" if name else None
    # Worked out for the tiles of the home page, which read them apart.
    out.pop("excerpt", None)
    out.pop("excerpt_rule", None)
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


async def list_tiles(db: aiosqlite.Connection) -> list[dict]:
    """What a tile of the home page draws, in the order of `list_all`, without the long fields.
    A card with no excerpt yet, or one worked out by an older rule, has it made here and kept."""
    rows = await (await db.execute(
        "SELECT id, kind, name, nickname, tagline, tags, excerpt, avatar_path, avatar_thumb_path,"
        " is_favorite, card_rules, created_at, updated_at,"
        # The description is read only for the cards that need an excerpt made from it.
        " CASE WHEN excerpt IS NULL OR excerpt_rule != ? THEN description END AS made_from"
        " FROM characters ORDER BY is_favorite DESC, updated_at DESC",
        (card_text.EXCERPT_RULE,))).fetchall()
    todo = [r for r in rows if r["made_from"] is not None]
    made: dict[str, str] = {}
    if todo:
        # Pure Python on text of any length: off the loop, so the server answers meanwhile.
        pairs = [(r["made_from"], r["name"]) for r in todo]
        excerpts = await asyncio.to_thread(lambda: [card_text.card_excerpt(d, n) for d, n in pairs])
        made = {r["id"]: e for r, e in zip(todo, excerpts, strict=True)}
        rule = card_text.EXCERPT_RULE
        async with write_transaction(db):
            for r, (description, name) in zip(todo, pairs, strict=True):
                # Only if the card is still what the excerpt was made from: one edited since
                # keeps its NULL and is redone by the next list.
                await db.execute(
                    "UPDATE characters SET excerpt = ?, excerpt_rule = ?"
                    " WHERE id = ? AND name = ? AND description = ?",
                    (made[r["id"]], rule, r["id"], name, description))
    tiles = []
    for r in rows:
        tiles.append({
            "id": r["id"], "kind": r["kind"], "name": r["name"], "nickname": r["nickname"],
            "tagline": r["tagline"], "tags": loads(r["tags"], []),
            "excerpt": made[r["id"]] if r["id"] in made else r["excerpt"],
            "avatar_url": f"api/media/{r['avatar_path']}" if r["avatar_path"] else None,
            "avatar_thumb_url": (f"api/media/{r['avatar_thumb_path']}"
                                 if r["avatar_thumb_path"] else None),
            "is_favorite": bool(r["is_favorite"]), "card_rules": r["card_rules"],
            "created_at": r["created_at"], "updated_at": r["updated_at"],
        })
    return tiles


async def search(db: aiosqlite.Connection, words: str) -> list[str]:
    """The ids of the cards whose name, tagline or description holds `words` in one piece, as the
    home page searched the list it had. The descriptions no longer travel to it."""
    needle = words.lower()
    if not needle:
        return []
    rows = await (await db.execute(
        "SELECT id, name, tagline, description FROM characters"
        " ORDER BY is_favorite DESC, updated_at DESC")).fetchall()
    return [r["id"] for r in rows
            if needle in r["name"].lower() or needle in r["tagline"].lower()
            or needle in r["description"].lower()]


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
        if key in ("name", "description") and "excerpt = NULL" not in sets:
            sets.append("excerpt = NULL")  # the tile's excerpt is made again from what is written
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


async def set_portrait(db: aiosqlite.Connection, char_id: str, avatar_path: str) -> dict | None:
    """A new portrait is an edit, and brings the card to the front. The copies of the one before
    are no longer its copies: the home page shows the whole picture until a page sends new ones."""
    cursor = await db.execute(
        "UPDATE characters SET avatar_path = ?, avatar_thumb_path = '', avatar_backdrop_path = '',"
        " updated_at = ? WHERE id = ?", (avatar_path, now_iso(), char_id))
    await db.commit()
    return await get(db, char_id) if cursor.rowcount else None


async def keep_sizes(db: aiosqlite.Connection, char_id: str, portrait: str, grid_path: str,
                     backdrop_path: str
                     ) -> Literal["kept", "made_already", "portrait_changed", "not_found"]:
    """Keeps the copies of `portrait` when it is still the character's and none are kept yet, in
    one statement: no other request can come between the check and the write. Copies are no edit,
    and leave updated_at, by which the home page sorts, as it was."""
    cursor = await db.execute(
        "UPDATE characters SET avatar_thumb_path = ?, avatar_backdrop_path = ?"
        " WHERE id = ? AND avatar_path = ? AND avatar_thumb_path = ''",
        (grid_path, backdrop_path, char_id, portrait))
    await db.commit()
    if cursor.rowcount:
        return "kept"
    row = await (await db.execute(
        "SELECT avatar_path FROM characters WHERE id = ?", (char_id,))).fetchone()
    if not row:
        return "not_found"
    return "portrait_changed" if row["avatar_path"] != portrait else "made_already"


async def delete(db: aiosqlite.Connection, char_id: str) -> bool:
    cursor = await db.execute("DELETE FROM characters WHERE id = ?", (char_id,))
    await db.commit()
    return cursor.rowcount > 0
