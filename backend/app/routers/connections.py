"""Services: a server and its key. A page opened before the update still calls some of these
routes with a whole connection: what it can no longer do is refused with a word to reload."""

import aiosqlite
from fastapi import APIRouter, Depends

from ..db import get_db
from ..errors import KEY_NEEDED, PAGE_OUTDATED, RELOAD, SERVICE_IN_USE, AppError, NotFoundError
from ..models.schemas import ConnectionBefore, ProbeIn, ServiceRef, ServiceUpdate
from ..providers import catalog, get_provider
from ..repositories import connections as repo
from ..repositories.connections import bare

router = APIRouter(prefix="/api/connections", tags=["connections"])


def _key_needed() -> AppError:
    return AppError("A new address needs its key typed again, or none: a key is only sent to the "
                    "address it was given for.", 422, kind=KEY_NEEDED)


async def held_service(db: aiosqlite.Connection, ref: ServiceRef) -> dict:
    """The service as the page holds it, key included: the one place a saved key is lent. A
    saved service as it is; a draft with its key typed, or "" for none; a draft with no key only
    takes the saved one's while its API and address are those the key was given for."""
    saved = await repo.get_raw(db, ref.id) if ref.id else None
    if not ref.draft:
        if saved is None:
            raise NotFoundError("Service not found.", "connection")
        return {**saved, "family": ref.family or saved["family"],
                "family_url": bare(saved["base_url"]) if ref.family else saved["family_url"]}
    same = saved is not None and (saved["provider"], bare(saved["base_url"])) == (
        ref.provider, bare(ref.base_url))
    if ref.api_key is not None:
        key = ref.api_key
    elif same or saved is None or not saved["api_key"]:
        key = saved["api_key"] if same else ""
    else:
        raise _key_needed()
    if ref.family:
        family, family_url = ref.family, bare(ref.base_url)
    elif same:
        family, family_url = saved["family"], saved["family_url"]
    else:
        family, family_url = "generic", None
    return {"id": saved["id"] if same else None, "name": ref.name or (saved or {}).get("name"),
            "provider": ref.provider, "base_url": ref.base_url, "api_key": key,
            "family": family, "family_url": family_url}


def _outdated(status: int, message: str) -> AppError:
    return AppError(message, status, kind=PAGE_OUTDATED)


@router.get("")
async def list_services(db: aiosqlite.Connection = Depends(get_db)):
    return await repo.list_all(db)


@router.post("")
async def create_connection_before():
    """A page from before the update adds a connection: it would make a service with no AI."""
    raise _outdated(410, RELOAD)


@router.post("/benchmark")
async def benchmark_before():
    """A page from before the update measures its form: the speed test is an AI's now."""
    raise _outdated(410, RELOAD)


@router.put("/{service_id}")
async def update_service(service_id: str, payload: ServiceUpdate,
                         db: aiosqlite.Connection = Depends(get_db)):
    if payload.model_extra:
        # A page from before sends the whole connection: its model and figures would be lost.
        raise _outdated(422, f"{RELOAD} Nothing was saved.")
    saved = await repo.get_raw(db, service_id)
    if saved is None:
        raise NotFoundError("Service not found.", "connection")
    moved = (payload.base_url is not None and bare(payload.base_url) != bare(saved["base_url"])
             or payload.provider is not None and payload.provider != saved["provider"])
    if moved and saved["api_key"] and payload.api_key is None:
        raise _key_needed()
    return await repo.update(db, service_id, payload.model_dump())


@router.delete("/{service_id}", status_code=204)
async def delete_service(service_id: str, db: aiosqlite.Connection = Depends(get_db)):
    """Only a service with no AI, as the release before can leave one. One that holds AIs is
    what a page from before would remove with every AI on it."""
    removed = await repo.delete_if_empty(db, service_id)
    if removed is None:
        raise NotFoundError("Service not found.", "connection")
    if not removed:
        raise AppError("This service still holds AIs, so nothing was removed. If this page was "
                       "open before Evermind was updated, reload it.", 409, kind=SERVICE_IN_USE)


@router.post("/probe")
async def probe(payload: ProbeIn, db: aiosqlite.Connection = Depends(get_db)):
    """Every model the service's server lists, as the page shows them; saves nothing."""
    service = await held_service(db, payload)
    read = await catalog.read_catalog(service, fresh=payload.fresh)
    if not payload.draft:
        service_id = payload.id
    else:
        same = await repo.find_same(db, service["provider"], service["base_url"],
                                    service["api_key"])
        service_id = same["id"] if same else None
    return {"family": read.family, "local": catalog.is_local(read.family, service["base_url"]),
            "read_at": read.read_at, "service_id": service_id,
            "dropped": catalog.dropped(read), "models": catalog.relayed(read)}


@router.post("/test")
async def test_before(draft: ConnectionBefore, db: aiosqlite.Connection = Depends(get_db)):
    """A page from before the update tests its form: answered as it was, saving nothing."""
    service = await held_service(db, ServiceRef(id=draft.id, provider=draft.provider,
                                                base_url=draft.base_url, api_key=draft.api_key))
    models = await get_provider(service).list_models()
    return {"ok": True, "detail": f"{len(models)} models available",
            "model_count": len(models), "models_sample": models[:8]}
