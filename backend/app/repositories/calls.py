"""The rows of `calls` once written (services/calls.py writes them)."""

import aiosqlite


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
