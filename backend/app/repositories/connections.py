"""Services: a server, its API and its key, kept once for every AI that runs on it.

The table is still called connections, and keeps the columns a connection held for its one model:
frozen at the update, read and written by nothing here, for the release before to run on.
"""

import aiosqlite

from ..providers.catalog import family_of, is_local, is_loopback
from .base import new_id, now_iso


def bare(base_url: str | None) -> str:
    """An address without its final "/": the same server either way."""
    return (base_url or "").rstrip("/")


def hint(key: str | None) -> str:
    return f"…{key[-4:]}" if key else ""


def to_out(row, model_count: int = 0) -> dict:
    """Public shape: the API key never leaves the backend, only its end."""
    service = dict(row)
    family = family_of(service["provider"], service["base_url"], service["family"],
                       service["family_url"])
    return {
        "id": service["id"], "name": service["name"], "provider": service["provider"],
        "family": family, "base_url": service["base_url"],
        "local": is_local(family, service["base_url"]),
        "loopback": is_loopback(service["base_url"]),
        "api_key_set": bool(service["api_key"]), "api_key_hint": hint(service["api_key"]),
        "model_count": model_count,
        "created_at": service["created_at"], "updated_at": service["updated_at"],
    }


_WITH_COUNT = ("SELECT c.*, (SELECT COUNT(*) FROM models m WHERE m.connection_id = c.id)"
               " AS model_count FROM connections c")


async def list_all(db: aiosqlite.Connection) -> list[dict]:
    rows = await (await db.execute(f"{_WITH_COUNT} ORDER BY c.created_at, c.rowid")).fetchall()
    return [to_out(r, r["model_count"]) for r in rows]


async def get(db: aiosqlite.Connection, service_id: str) -> dict | None:
    row = await (await db.execute(f"{_WITH_COUNT} WHERE c.id = ?", (service_id,))).fetchone()
    return to_out(row, row["model_count"]) if row else None


async def get_raw(db: aiosqlite.Connection, service_id: str) -> dict | None:
    """The service with its key, for whatever lends it to a request."""
    row = await (await db.execute("SELECT * FROM connections WHERE id = ?",
                                  (service_id,))).fetchone()
    return dict(row) if row else None


async def find_same(db: aiosqlite.Connection, provider: str, base_url: str,
                    api_key: str) -> dict | None:
    """The saved service of this API, address (with or without its final "/") and key: a key is
    never kept twice for one server."""
    row = await (await db.execute(
        "SELECT * FROM connections WHERE provider = ? AND rtrim(base_url, '/') = ?"
        " AND api_key = ? ORDER BY created_at, rowid LIMIT 1",
        (provider, bare(base_url), api_key or ""))).fetchone()
    return dict(row) if row else None


async def names(db: aiosqlite.Connection) -> set[str]:
    return {r["name"] for r in await (await db.execute("SELECT name FROM connections")).fetchall()}


async def insert(db: aiosqlite.Connection, fields: dict) -> str:
    """A new service. Does not commit: it belongs to the AIs it is made for."""
    service_id = new_id()
    now = now_iso()
    await db.execute(
        "INSERT INTO connections (id, name, provider, base_url, api_key, family, family_url,"
        " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (service_id, fields["name"], fields["provider"], fields["base_url"],
         fields.get("api_key") or "", fields["family"], bare(fields["base_url"]), now, now))
    return service_id


async def learn_family(db: aiosqlite.Connection, service: dict, family: str | None) -> None:
    """A family found by a read, kept for a service that had none, at the address it was found
    at; never over one its address names. Does not commit."""
    if not family or family == "generic":
        return
    known = family_of(service["provider"], service["base_url"], service["family"],
                      service["family_url"])
    if known == "generic":
        await db.execute(
            "UPDATE connections SET family = ?, family_url = ? WHERE id = ? AND base_url = ?",
            (family, bare(service["base_url"]), service["id"], service["base_url"]))


async def update(db: aiosqlite.Connection, service_id: str, fields: dict) -> dict | None:
    """``fields``: name, provider, base_url, api_key (None keeps it, "" clears it). A changed
    address or API asks the family again."""
    saved = await get_raw(db, service_id)
    if saved is None:
        return None
    after = {**saved, **{k: v for k, v in fields.items() if v is not None and k != "api_key"}}
    family, family_url = saved["family"], saved["family_url"]
    if (after["provider"], bare(after["base_url"])) != (saved["provider"],
                                                          bare(saved["base_url"])):
        family = family_of(after["provider"], after["base_url"], saved["family"],
                           saved["family_url"])
        family_url = bare(after["base_url"])
    await db.execute(
        "UPDATE connections SET name = ?, provider = ?, base_url = ?,"
        " api_key = COALESCE(?, api_key), family = ?, family_url = ?, updated_at = ?"
        " WHERE id = ?",
        (after["name"], after["provider"], after["base_url"], fields.get("api_key"), family,
         family_url, now_iso(), service_id))
    await db.commit()
    return await get(db, service_id)


async def delete_if_empty(db: aiosqlite.Connection, service_id: str) -> bool | None:
    """Removes a service that holds no AI. None when there is no such service, False when it
    still holds some."""
    if await get_raw(db, service_id) is None:
        return None
    cursor = await db.execute(
        "DELETE FROM connections WHERE id = ?"
        " AND NOT EXISTS (SELECT 1 FROM models WHERE connection_id = ?)",
        (service_id, service_id))
    await db.commit()
    return cursor.rowcount > 0


async def name_families(db: aiosqlite.Connection) -> None:
    """At start-up: each service's family as its address gives it. The release before can have
    made a service (with no family) or moved one to another address since."""
    rows = await (await db.execute("SELECT * FROM connections")).fetchall()
    for row in rows:
        family = family_of(row["provider"], row["base_url"], row["family"], row["family_url"])
        if (family, row["family_url"]) != (row["family"], bare(row["base_url"])):
            await db.execute("UPDATE connections SET family = ?, family_url = ? WHERE id = ?",
                             (family, bare(row["base_url"]), row["id"]))
    await db.commit()
