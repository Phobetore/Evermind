"""AIs: a model chosen on a service, with what it reads at once, its ceiling, its settings and its
price. A conversation names one; the service holds the key."""

import aiosqlite

from ..db import write_transaction
from ..errors import NotFoundError
from ..prompting import ways
from ..providers.catalog import (
    LOCAL_FAMILIES,
    Listed,
    amount,
    family_of,
    is_local,
    is_loopback,
    whole,
)
from ..services import ai_call
from . import connections as services_repo
from . import settings as settings_repo
from .base import new_id, now_iso

# The one that answers when none is named: the marked default, else the oldest.
_DEFAULT_FIRST = "m.is_default DESC, m.created_at, m.rowid"
# How sure a size read is: what the server serves, what it is set to load, what was seen, the
# trained maximum. A read never puts a less sure one over a surer one.
_SURE = {"served": 4, "configured": 3, "observed": 2, "max": 1}
# The settings an AI added on a model that does not reason is given: today's form for roleplay.
ROLEPLAY = {"temperature": 0.8, "top_p": 0.95, "frequency_penalty": 0.15,
            "presence_penalty": 0.15}
SAMPLING = tuple(ROLEPLAY)
_READ = ("context_read", "context_read_kind", "output_read", "reasons", "price_in", "price_out",
         "price_cache_read", "price_cache_write", "price_varies", "limits_read_at")


def _family(service: dict) -> str:
    return family_of(service["provider"], service["base_url"], service["family"],
                     service["family_url"])


def _price(model: dict, read: str, own: str) -> float | None:
    return model[read] if model[read] is not None else model[own]


def is_free(model: dict, service: dict) -> bool:
    """The only definition, which the page reads and never works out again: a server at home of a
    family that loads its own models, with no price typed, or a price of 0 and 0, read or typed.
    A gateway of no known family is not free, even at home: it may forward to a paid service."""
    family = _family(service)
    typed = model["price_own_in"] is not None or model["price_own_out"] is not None
    if family in LOCAL_FAMILIES and not typed and is_local(family,
                                                                          service["base_url"]):
        return True
    return (_price(model, "price_in", "price_own_in") == 0
            and _price(model, "price_out", "price_own_out") == 0)


def to_out(model_row, service_row, conversation_count: int = 0,
           room: int | None = None) -> dict:
    """Public shape: the key never leaves, only its end. ``room`` is the reply room of the way
    offered to new conversations, which its notices weigh."""
    model, service = dict(model_row), dict(service_row)
    family = _family(service)
    counted = ai_call.window(model, family=family)
    return {
        "id": model["id"],
        "service": {
            "id": service["id"], "name": service["name"], "family": family,
            "local": is_local(family, service["base_url"]),
            "loopback": is_loopback(service["base_url"]),
            "provider": service["provider"], "base_url": service["base_url"],
            "api_key_set": bool(service["api_key"]),
            "api_key_hint": services_repo.hint(service["api_key"]),
        },
        "model": model["model"], "name": model["name"], "is_default": bool(model["is_default"]),
        "context": {"own": model["context_own"], "read": model["context_read"],
                    "read_kind": model["context_read_kind"], "used": counted.tokens,
                    "source": counted.source},
        "output_read": model["output_read"],
        "reasons": None if model["reasons"] is None else bool(model["reasons"]),
        "price": {"read_in": model["price_in"], "read_out": model["price_out"],
                  "own_in": model["price_own_in"], "own_out": model["price_own_out"],
                  "varies": bool(model["price_varies"])},
        "free": is_free(model, service),
        "limits_read_at": model["limits_read_at"],
        "reply_cap": {"mode": model["reply_cap_mode"], "tokens": model["reply_cap_tokens"]},
        **{key: model[key] for key in SAMPLING},
        "migrated": bool(model["migrated"]),
        "notices": ai_call.notices(model, room),
        "conversation_count": conversation_count,
        "created_at": model["created_at"], "updated_at": model["updated_at"],
    }


_JOINED = ("SELECT m.*, (SELECT COUNT(*) FROM conversations v WHERE v.model_id = m.id)"
           " AS conversation_count FROM models m")


async def _services(db: aiosqlite.Connection) -> dict[str, dict]:
    rows = await (await db.execute("SELECT * FROM connections")).fetchall()
    return {r["id"]: dict(r) for r in rows}


async def list_all(db: aiosqlite.Connection) -> list[dict]:
    """In the order `resolve` picks them; with none marked, the first is the default."""
    rows = await (await db.execute(f"{_JOINED} ORDER BY {_DEFAULT_FIRST}")).fetchall()
    services = await _services(db)
    room = ways.way_for(None, await settings_repo.get_all(db))["reply_room"]
    out = [to_out(r, services[r["connection_id"]], r["conversation_count"], room) for r in rows]
    if out:
        out[0]["is_default"] = True
    return out


async def get_row(db: aiosqlite.Connection, model_id: str) -> dict | None:
    row = await (await db.execute("SELECT * FROM models WHERE id = ?", (model_id,))).fetchone()
    return dict(row) if row else None


async def get(db: aiosqlite.Connection, model_id: str) -> dict | None:
    return next((m for m in await list_all(db) if m["id"] == model_id), None)


async def _default(db: aiosqlite.Connection, leaving: str | None = None) -> dict | None:
    row = await (await db.execute(
        f"SELECT m.* FROM models m WHERE m.id IS NOT ? ORDER BY {_DEFAULT_FIRST} LIMIT 1",
        (leaving,))).fetchone()
    return dict(row) if row else None


async def resolve(db: aiosqlite.Connection, wanted: str | None) -> tuple[dict, dict] | None:
    """The AI asked for while it exists, else the default, else the oldest; with its service,
    key included."""
    row = await (await db.execute(
        f"SELECT m.* FROM models m ORDER BY m.id IS ? DESC, {_DEFAULT_FIRST} LIMIT 1",
        (wanted,))).fetchone()
    if row is None:
        return None
    return dict(row), await services_repo.get_raw(db, row["connection_id"])


async def by_any_id(db: aiosqlite.Connection, some_id: str | None) -> dict | None:
    """The AI of that id; else, for a page from before AIs, which names a service, that
    service's first AI (its default, then its oldest)."""
    if not some_id:
        return None
    row = await (await db.execute(
        f"SELECT m.* FROM models m WHERE m.id = ? OR m.connection_id = ?"
        f" ORDER BY m.id = ? DESC, {_DEFAULT_FIRST} LIMIT 1",
        (some_id, some_id, some_id))).fetchone()
    return dict(row) if row else None


def _from_read(read: dict | None) -> dict:
    """What the page sends back of the probe's list, as columns: read again here, so that a value
    of an odd shape is not told. Prices are already in USD per million."""
    if not isinstance(read, dict):
        return {}
    context = read.get("context") if isinstance(read.get("context"), dict) else {}
    price = read.get("price") if isinstance(read.get("price"), dict) else {}
    out: dict = {}
    for kind in ("served", "configured", "max"):
        if (size := whole(context.get(kind))) is not None:
            out["context_read"], out["context_read_kind"] = size, kind
            break
    out["output_read"] = whole(read.get("max_output"))
    reasons = read.get("reasons")
    out["reasons"] = int(reasons) if isinstance(reasons, bool) else None
    out["price_in"], out["price_out"] = amount(price.get("input")), amount(price.get("output"))
    out["price_cache_read"] = amount(price.get("cache_read"))
    out["price_cache_write"] = amount(price.get("cache_write"))
    out["price_varies"] = int(price.get("varies") is True)
    out["limits_read_at"] = now_iso()
    return out


def from_listed(listed: Listed) -> dict:
    """A model as its server lists it, in the page's relayed shape."""
    return {"context": {"served": listed.served, "configured": listed.configured,
                        "max": listed.max},
            "max_output": listed.max_output, "reasons": listed.reasons,
            "price": {"input": listed.price_in, "output": listed.price_out,
                      "varies": listed.price_varies, "cache_read": listed.price_cache_read,
                      "cache_write": listed.price_cache_write}}


async def create_many(db: aiosqlite.Connection, service: dict | None, service_id: str | None,
                      items: list[dict], conversation_id: str | None) -> dict:
    """One write: a new service (``service``, when ``service_id`` is None) or the changes to a
    saved one (its new key, a family learned), the AIs, and the conversation that asked for them,
    given the last. ``items``: {model, name, context_own, price_own_in, price_own_out, read,
    reasons_read, label}. A model already on the service is not added twice: its AI is returned.
    None when the conversation no longer exists, and NotFoundError when the saved service no
    longer does, with nothing written."""
    from . import conversations as convo_repo

    made: list[str] = []
    async with write_transaction(db):
        if conversation_id is not None and not await (await db.execute(
                "SELECT 1 FROM conversations WHERE id = ?", (conversation_id,))).fetchone():
            return {}
        if service_id is None:
            service_id = await services_repo.insert(db, service)
        elif await services_repo.get_raw(db, service_id) is None:
            # Removed since it was looked up, with its last AI: nothing is written.
            raise NotFoundError("Service not found.", "connection")
        elif service:
            saved = await services_repo.get_raw(db, service_id)
            if service.get("api_key") is not None:
                await db.execute("UPDATE connections SET api_key = ?, updated_at = ? WHERE id = ?",
                                 (service["api_key"], now_iso(), service_id))
            await services_repo.learn_family(db, saved, service.get("family"))
        saved = await services_repo.get_raw(db, service_id)
        family = _family(saved)
        for item in items:
            row = await (await db.execute(
                "SELECT id FROM models WHERE connection_id = ? AND model = ?"
                " ORDER BY created_at, rowid LIMIT 1", (service_id, item["model"]))).fetchone()
            if row is not None:
                made.append(row["id"])
                continue
            made.append(await _insert(db, service_id, saved, family, item))
        if conversation_id is not None:
            await db.execute(
                "UPDATE conversations SET model_id = ?, connection_id = NULL, model_lost = NULL,"
                " updated_at = ? WHERE id = ?", (made[-1], now_iso(), conversation_id))
    models = [await get(db, model_id) for model_id in made]
    return {
        "service": await services_repo.get(db, service_id),
        "models": models,
        "conversation": (await convo_repo.get(db, conversation_id, with_messages=False)
                         if conversation_id else None),
    }


async def _insert(db: aiosqlite.Connection, service_id: str, service: dict, family: str,
                  item: dict) -> str:
    read = _from_read(item.get("read"))
    reasons = read.get("reasons")
    # OpenAI's newest models refuse these, Anthropic's take only some, and a model that reasons
    # is best left to its own.
    settings = ({} if family in ("openai", "anthropic") or service["provider"] == "anthropic"
                or reasons == 1 else ROLEPLAY)
    taken = {r["name"] for r in await (await db.execute("SELECT name FROM models")).fetchall()}
    name = item.get("name") or item["label"]
    if name in taken:
        name = f"{name} ({service['name']})"
    first = not await (await db.execute("SELECT 1 FROM models LIMIT 1")).fetchone()
    model_id = new_id()
    now = now_iso()
    fields = {
        "id": model_id, "connection_id": service_id, "model": item["model"], "name": name,
        "is_default": int(first), "context_own": item.get("context_own"),
        "price_own_in": item.get("price_own_in"), "price_own_out": item.get("price_own_out"),
        # OpenAI's models that reason refuse max_tokens and its list does not say which do: the
        # model it was given by default sent none.
        "reply_cap_mode": "unsent" if family == "openai" else "auto",
        **{key: settings.get(key) for key in SAMPLING},
        **read, "created_at": now, "updated_at": now,
    }
    await db.execute(f"INSERT INTO models ({', '.join(fields)})"
                     f" VALUES ({', '.join('?' for _ in fields)})", tuple(fields.values()))
    return model_id


async def update(db: aiosqlite.Connection, model_id: str, fields: dict) -> dict | None:
    """``fields`` as ModelUpdate gave them, only those sent. A model id changed forgets in the
    same write all that was read of the one before; what was typed stays."""
    sets: dict = {}
    for key in ("name", "model", "context_own", *SAMPLING, "price_own_in", "price_own_out"):
        if key in fields:
            sets[key] = fields[key]
    if "notices_kept" in fields and fields["notices_kept"] is not None:
        sets["notices_kept"] = int(fields["notices_kept"])
    if fields.get("reply_cap") is not None:
        cap = fields["reply_cap"]
        sets["reply_cap_mode"] = cap["mode"]
        sets["reply_cap_tokens"] = cap.get("tokens") if cap["mode"] == "fixed" else None
    async with write_transaction(db):
        current = await get_row(db, model_id)
        if current is None:
            return None
        if "model" in sets and sets["model"] is not None and sets["model"] != current["model"]:
            sets.update({key: None for key in _READ})
            sets["price_varies"] = 0
        elif sets.get("model") is None:
            sets.pop("model", None)
        if sets.get("name") is None:
            sets.pop("name", None)
        if fields.get("is_default"):
            await db.execute("UPDATE models SET is_default = 0 WHERE is_default = 1")
            sets["is_default"] = 1
        sets["updated_at"] = now_iso()
        await db.execute(f"UPDATE models SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?",
                         (*sets.values(), model_id))
    return await get(db, model_id)


async def successor(db: aiosqlite.Connection, model_id: str) -> dict | None:
    """The AI that answers its conversations once it is removed: the default, or, when it is the
    default, the oldest other. None when it is the last."""
    default = await _default(db)
    if default is None:
        return None
    if default["id"] != model_id:
        return default
    row = await (await db.execute(
        "SELECT * FROM models WHERE id <> ? ORDER BY created_at, rowid LIMIT 1",
        (model_id,))).fetchone()
    return dict(row) if row else None


async def delete(db: aiosqlite.Connection, model_id: str) -> bool:
    """In one write: the default handed on, its conversations fixed on the default of this moment
    and told which AI they lost, then the AI, then its service if it held no other (its key is
    forgotten with it)."""
    async with write_transaction(db):
        current = await get_row(db, model_id)
        if current is None:
            return False
        after = await successor(db, model_id)
        was_default = (await _default(db))["id"] == model_id
        if was_default and after is not None:
            await db.execute("UPDATE models SET is_default = 0 WHERE is_default = 1")
            await db.execute("UPDATE models SET is_default = 1 WHERE id = ?", (after["id"],))
        await db.execute(
            "UPDATE conversations SET model_lost = ?, model_id = ? WHERE model_id = ?",
            (current["name"], after["id"] if after else None, model_id))
        await db.execute("DELETE FROM models WHERE id = ?", (model_id,))
        await db.execute(
            "DELETE FROM connections WHERE id = ?"
            " AND NOT EXISTS (SELECT 1 FROM models WHERE connection_id = ?)",
            (current["connection_id"], current["connection_id"]))
    return True


async def store_read(db: aiosqlite.Connection, model_id: str, model: str, read_from: dict,
                     listed: Listed | None, family: str | None) -> None:
    """What a read of ``model`` at the service ``read_from`` (as it was when the read began)
    found, kept only while the AI still names that model and its service is still at that API
    and address, and only where it says more: a size never replaced by a less sure one,
    reasoning never unlearned. A model no longer listed keeps all it had. The family found is
    kept for a generic service."""
    async with write_transaction(db):
        current = await get_row(db, model_id)
        if current is None or current["model"] != model:
            return
        service = await services_repo.get_raw(db, current["connection_id"])
        if service is None or not services_repo.same_server(service, read_from):
            return  # moved meanwhile: what the old address said is not this one's
        await services_repo.learn_family(db, service, family)
        sets: dict = {"limits_read_at": now_iso()}
        if listed is not None:
            for kind in ("served", "configured", "max"):
                size = getattr(listed, kind)
                if size is None:
                    continue
                if _SURE[kind] >= _SURE.get(current["context_read_kind"], 0):
                    sets["context_read"], sets["context_read_kind"] = size, kind
                break
            if listed.max_output is not None:
                sets["output_read"] = listed.max_output
            if listed.reasons is True:
                sets["reasons"] = 1
            elif listed.reasons is False and current["reasons"] is None:
                sets["reasons"] = 0
            for column, value in (("price_in", listed.price_in), ("price_out", listed.price_out),
                                  ("price_cache_read", listed.price_cache_read),
                                  ("price_cache_write", listed.price_cache_write)):
                if value is not None:
                    sets[column] = value
            if listed.price_varies or listed.price_in is not None or listed.price_out is not None:
                sets["price_varies"] = int(listed.price_varies)
        await db.execute(
            f"UPDATE models SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ? AND model = ?",
            (*sets.values(), model_id, model))


async def learn_reasons(db: aiosqlite.Connection, model_id: str, model: str) -> None:
    """A reply showed reasoning: the AI reasons, while it still names that model. Gone, nothing."""
    await db.execute("UPDATE models SET reasons = 1 WHERE id = ? AND model = ?", (model_id, model))
    await db.commit()
