"""The rows of `calls` once written (services/calls.py writes them)."""

from typing import TYPE_CHECKING

import aiosqlite

if TYPE_CHECKING:
    from ..services.calls import Pricing


async def claim(db: aiosqlite.Connection, job_ids: list[str], card_id: str, name: str,
                kind: str) -> int:
    """The drafts of a card not saved yet, now that it is: what writing her cost counts under her
    name. A row that already names a card keeps it. Commits. Returns how many rows it took."""
    if not job_ids:
        return 0
    cursor = await db.execute(
        "UPDATE calls SET card_id = ?, card_name = ?, card_kind = ?"
        f" WHERE card_id IS NULL AND job_id IN ({', '.join('?' for _ in job_ids)})",
        (card_id, name, kind, *job_ids))
    await db.commit()
    return cursor.rowcount


async def reprice(db: aiosqlite.Connection, model_id: str, model: str, pricing: "Pricing") -> int:
    """Inside the caller's transaction: the rows of that AI and that server id with no price get
    the price typed now. Returns how many.

    A known amount never changes, a refusal costs nothing, and a call still running ends with the
    price copied at its start. A typed price has no cache prices: what came from the cache, or
    went to it, is counted as money_of counts it then."""
    cursor = await db.execute(
        "UPDATE calls SET"
        " price_in = :pin, price_out = :pout, price_cache_read = NULL, price_cache_write = NULL,"
        " price_source = 'typed_later', local = 0, cost_source = 'computed',"
        " cost = (MAX(0, tokens_in - COALESCE(tokens_cached, 0) - COALESCE(tokens_cache_write, 0))"
        " * :pin"
        " + COALESCE(tokens_cached, 0) * :pin"
        " + COALESCE(tokens_cache_write, 0) * 2 * :pin"
        " + tokens_out * :pout) / 1e6"
        " WHERE model_id = :model_id AND model_asked = :model"
        " AND cost_source = 'none' AND outcome NOT IN ('refused', 'running')",
        {"pin": pricing.price_in, "pout": pricing.price_out, "model_id": model_id,
         "model": model})
    return cursor.rowcount
