"""The ways of playing as a person keeps them: the four built in with what was changed of them, and
the ways of their own, in the settings ``play_styles`` and ``default_play_style``.

Each change reads them again inside its own transaction and writes back only what it changes, so
that two devices changing two ways at once keep both changes.
"""

import aiosqlite

from ..db import write_transaction
from ..errors import WAY_BUILT_IN, AppError, NotFoundError
from ..prompting import embeddings, ways
from . import settings as settings_repo
from .base import new_id


def _styles(settings: dict) -> dict:
    """What is stored, as lists and objects even when written by hand as something else."""
    stored = settings.get("play_styles")
    stored = stored if isinstance(stored, dict) else {}
    overrides = stored.get("overrides")
    custom = stored.get("custom")
    return {"overrides": dict(overrides) if isinstance(overrides, dict) else {},
            "custom": [c for c in custom if isinstance(c, dict)] if isinstance(custom, list) else []}


def _missing() -> NotFoundError:
    return NotFoundError("Way not found.", "way")


async def _read(db: aiosqlite.Connection) -> tuple[dict, str | None]:
    settings = await settings_repo.get_all(db)
    return _styles(settings), settings.get("default_play_style")


def _known(styles: dict, way_id: str) -> bool:
    return way_id in ways.BUILT_IN or any(c.get("id") == way_id for c in styles["custom"])


def _default_of(styles: dict, default_id: str | None) -> str:
    """The way new conversations play: the one offered, else balanced when it is gone."""
    return ways.way_of(styles, None, default_id)["id"]


async def offered(db: aiosqlite.Connection, way_id: str | None) -> str:
    """The way a conversation made now plays: the one asked for, or the one offered when none
    is. One that does not exist is not found."""
    styles, default_id = await _read(db)
    if way_id is None:
        return _default_of(styles, default_id)
    if not _known(styles, way_id):
        raise _missing()
    return way_id


async def known(db: aiosqlite.Connection, way_id: str) -> dict:
    """The way of that id, unadjusted; one that does not exist is not found."""
    styles, default_id = await _read(db)
    if not _known(styles, way_id):
        raise _missing()
    return ways.way_of(styles, way_id, default_id)


async def plays(db: aiosqlite.Connection, way_id: str | None) -> dict:
    """The way a conversation playing that id plays, unadjusted: an id no longer known plays the
    way offered, then balanced."""
    styles, default_id = await _read(db)
    return ways.way_of(styles, way_id, default_id)


def _ids(styles: dict) -> list[str]:
    """The four built in first in their order, then the person's own by creation."""
    return [*ways.BUILT_IN, *(c["id"] for c in styles["custom"] if c.get("id"))]


def every(settings: dict) -> list[dict]:
    """Every way as the listing gives it, without its conversations, from settings read."""
    styles = _styles(settings)
    return [ways.way_of(styles, way_id, None) for way_id in _ids(styles)]


async def listing(db: aiosqlite.Connection) -> dict:
    styles, default_id = await _read(db)
    default = _default_of(styles, default_id)
    rows = await (await db.execute(
        "SELECT play_style, COUNT(*) AS n FROM conversations GROUP BY play_style")).fetchall()
    counts: dict[str, int] = {}
    for row in rows:
        # An id no longer known plays the way offered: it is counted there.
        way_id = row["play_style"] if _known(styles, row["play_style"]) else default
        counts[way_id] = counts.get(way_id, 0) + row["n"]
    ids = _ids(styles)
    return {
        "default": default,
        "passages_available": embeddings.installed(),
        "ways": [{**ways.way_of(styles, way_id, None), "conversations": counts.get(way_id, 0)}
                 for way_id in ids],
    }


async def _listed(db: aiosqlite.Connection, way_id: str) -> dict:
    return next(w for w in (await listing(db))["ways"] if w["id"] == way_id)


async def update(db: aiosqlite.Connection, way_id: str, changes: dict) -> dict:
    """A built-in way keeps only the fields that differ from its own values; a way of the
    person's own takes them all, and a new name."""
    async with write_transaction(db):
        styles, _ = await _read(db)
        if way_id in ways.BUILT_IN:
            if "name" in changes:
                raise AppError("A built-in way keeps its name.", 409, kind=WAY_BUILT_IN)
            original = ways.BUILT_IN[way_id]
            stored = styles["overrides"].get(way_id)
            merged = {**(stored if isinstance(stored, dict) else {}),
                      **{k: v for k, v in changes.items() if k in ways.FIELDS}}
            edits = {k: v for k, v in merged.items() if k in ways.FIELDS and v != original[k]}
            if edits:
                styles["overrides"][way_id] = edits
            else:
                styles["overrides"].pop(way_id, None)
        else:
            custom = next((c for c in styles["custom"] if c.get("id") == way_id), None)
            if custom is None:
                raise _missing()
            custom.update({k: v for k, v in changes.items() if k in (*ways.FIELDS, "name")})
        await settings_repo.store(db, "play_styles", styles)
    return await _listed(db, way_id)


async def copy(db: aiosqlite.Connection, from_id: str, name: str) -> dict:
    """A way of the person's own, made of another's values as it plays them."""
    made = new_id()
    async with write_transaction(db):
        styles, default_id = await _read(db)
        if not _known(styles, from_id):
            raise _missing()
        source = ways.way_of(styles, from_id, default_id)
        styles["custom"].append({"id": made, "name": name,
                                 **{k: source[k] for k in ways.FIELDS}})
        await settings_repo.store(db, "play_styles", styles)
    return await _listed(db, made)


async def _move(db: aiosqlite.Connection, from_id: str, to_id: str) -> int:
    """The conversations that play a way, moved to another, which they play whole: what they
    adjusted of the way removed goes, as when another way is chosen."""
    cursor = await db.execute("UPDATE conversations SET play_style = ?, play_overrides = NULL"
                              " WHERE play_style = ?", (to_id, from_id))
    return cursor.rowcount


async def remove(db: aiosqlite.Connection, way_id: str) -> dict:
    """A way of the person's own, gone; the conversations that play it play the way offered,
    in the same transaction: none is ever left on a way that no longer exists."""
    if way_id in ways.BUILT_IN:
        raise AppError("A built-in way cannot be removed.", 409, kind=WAY_BUILT_IN)
    async with write_transaction(db):
        styles, default_id = await _read(db)
        kept = [c for c in styles["custom"] if c.get("id") != way_id]
        if len(kept) == len(styles["custom"]):
            raise _missing()
        styles["custom"] = kept
        await settings_repo.store(db, "play_styles", styles)
        if default_id == way_id:
            default_id = "balanced"
            await settings_repo.store(db, "default_play_style", default_id)
        to = _default_of(styles, default_id)
        moved = await _move(db, way_id, to)
    return {"moved": moved, "to": to}


async def reset(db: aiosqlite.Connection, way_id: str) -> dict:
    """A built-in way back to its own values. A way of the person's own has none to go back to:
    it is left as it is."""
    async with write_transaction(db):
        styles, _ = await _read(db)
        if not _known(styles, way_id):
            raise _missing()
        if way_id in styles["overrides"]:
            del styles["overrides"][way_id]
            await settings_repo.store(db, "play_styles", styles)
    return await _listed(db, way_id)


async def set_default(db: aiosqlite.Connection, way_id: str) -> dict:
    async with write_transaction(db):
        styles, _ = await _read(db)
        if not _known(styles, way_id):
            raise _missing()
        await settings_repo.store(db, "default_play_style", way_id)
    return await listing(db)
