"""The journal of what went wrong on the server, for the page that shows it."""

from fastapi import APIRouter, Query

from .. import journal

router = APIRouter(prefix="/api/journal", tags=["journal"])


@router.get("")
async def read_journal(after: int | None = Query(None, ge=0), limit: int = Query(100, ge=1)) -> dict:
    # Past what is kept there is nothing more to give: a larger limit is not an error.
    return journal.current.read(after=after, limit=min(limit, journal.KEPT))


@router.delete("", status_code=204)
async def clear_journal() -> None:
    journal.current.clear()
