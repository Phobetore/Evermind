"""When what an AI's server says of it (its size, its ceiling, its price, whether it reasons) is
read again, after a reply, in the background.

Nothing here waits in front of a reply, and nothing here raises: a read that fails keeps what was
read before, and is not asked again for a while.
"""

import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta
from typing import Literal

from ..db import _connect
from ..providers.catalog import LOCAL_FAMILIES, family_of, read_one

logger = logging.getLogger(__name__)

# What a server says can change: a hosted model's price, its window.
READ_KEPT = timedelta(hours=24)
# A read that failed waits this long, as openai_compat's FAILED_LIST_KEPT_S: a server with no list
# (a proxy), or one switched off, would otherwise be asked again after every reply.
FAILED_READ_KEPT_S = 300

# The start of this process: a read made before it may be of a model loaded otherwise since.
started_at = datetime.now(UTC)
_now = time.monotonic
_failed: dict[str, float] = {}
# The local AIs read once after a reply in this process, whatever their last read says.
_loaded: set[str] = set()
_running: dict[str, asyncio.Task] = {}


def forget() -> None:
    """What this process learned of reads, for a test that starts from nothing."""
    _failed.clear()
    _loaded.clear()


def due(model: dict, service: dict, started_at: datetime, *,
        after_reply: bool = False) -> Literal["stale", "loaded"] | None:
    """Why an AI is to be read again, if it is: "loaded" (after a reply only, and once per AI and
    process) for a server that loads a size of its own and has not said what it serves, since an
    AI added before its model was loaded only says it now; "stale" for one never read, read
    before this process started, or more than a day ago. The only definition: the page never
    decides it."""
    family = family_of(service["provider"], service["base_url"], service.get("family") or
                       "generic", service.get("family_url"))
    failed = _failed.get(model["id"])
    if failed is not None and _now() - failed < FAILED_READ_KEPT_S:
        return None
    if (after_reply and family in LOCAL_FAMILIES and model.get("context_read_kind") != "served"
            and model["id"] not in _loaded):
        _loaded.add(model["id"])
        return "loaded"
    read_at = model.get("limits_read_at")
    if read_at is None:
        return "stale"
    try:
        when = datetime.fromisoformat(read_at)
    except ValueError:
        return "stale"
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    if when < started_at or datetime.now(UTC) - when > READ_KEPT:
        return "stale"
    return None


def schedule_refresh(model_id: str, *, fresh: bool) -> None:
    """Reads the AI again in the background, on a connection of its own, one read at a time per
    AI. ``fresh`` skips the list kept from an earlier read: only for a model just loaded, since
    every other read can share it, and a hosted service's list weighs 850 KB."""
    running = _running.get(model_id)
    if running is not None and not running.done():
        return
    task = asyncio.get_running_loop().create_task(_refresh(model_id, fresh))
    _running[model_id] = task
    task.add_done_callback(lambda done: _running.pop(model_id, None)
                           if _running.get(model_id) is done else None)


async def _refresh(model_id: str, fresh: bool) -> None:
    from ..repositories import connections as services_repo
    from ..repositories import models as models_repo

    try:
        db = await _connect()
    except Exception:  # noqa: BLE001
        logger.info("the limits of an AI could not be read again: no database")
        return
    try:
        model = await models_repo.get_row(db, model_id)
        service = await services_repo.get_raw(db, model["connection_id"]) if model else None
        if model is None or service is None:
            return  # removed meanwhile
        try:
            listed, family = await read_one(service, model["model"], fresh=fresh)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            _failed[model_id] = _now()
            # INFO: at WARNING it would add a line to evermind.log after every reply. The AI's
            # page says a failed read when it is opened.
            logger.info("the limits of %s could not be read again: %s", model["name"],
                        getattr(exc, "message", None) or type(exc).__name__)
            return
        _failed.pop(model_id, None)
        await models_repo.store_read(db, model_id, model["model"], service, listed,
                                    family)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        # Its name alone: a traceback's values could hold the key.
        logger.info("the limits of an AI could not be kept: %s", type(exc).__name__)
    finally:
        await db.close()


async def drain(*, cancel: bool = False) -> None:
    """Waits for every read scheduled. ``cancel``: at the server's stop, so that a read stuck on
    a slow server does not hold Ctrl+C for a minute; a read cancelled stores nothing, and a read
    that never ends replaces nothing."""
    while _running:
        tasks = list(_running.values())
        if cancel:
            for task in tasks:
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for task in tasks:
            for key, value in list(_running.items()):
                if value is task:
                    del _running[key]
