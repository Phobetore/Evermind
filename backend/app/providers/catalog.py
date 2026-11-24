"""Every model a server lists, and what it says of each: how much it reads at once, how long a
reply may be, its price and whether it reasons before it writes.

Each family of servers says it its own way (OpenRouter in its list, LM Studio, llama.cpp,
KoboldCpp and Ollama at addresses of their own); this module reads each as its documentation
gives it and keeps nothing it was not told. Nothing a server lists is left out of a read: only
``relayed`` holds back what cannot answer in a conversation, and says how many.
"""

import asyncio
import hashlib
import ipaddress
import json
import math
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Literal
from urllib.parse import urljoin, urlsplit

import httpx

from ..errors import MODEL_UNREADABLE
from .base import (
    LIST_DELAYS,
    LIST_TIMEOUT,
    ProviderError,
    _refusal,
    lost,
    well_formed,
)

Family = Literal["ollama", "lmstudio", "llamacpp", "koboldcpp", "openrouter", "openai",
                 "anthropic", "groq", "mistral", "generic"]
LOCAL_FAMILIES = {"ollama", "lmstudio", "llamacpp", "koboldcpp"}  # servers that load a size of their own
HOSTED_FAMILIES = {"openrouter", "openai", "anthropic", "groq", "mistral"}

# The whole read of a list, pages included: httpx's delay only counts between two pieces, and a
# server that sends a byte at a time would hold the request open for ever, even after "Cancel".
# Past a minute the person has given up.
LIST_WHOLE_S = 60
# A bound on the server's memory, not on the list: 75 times OpenRouter's whole list.
LIST_MAX_BYTES = 64 * 1024 * 1024
# The native probes together, from the first one sent: a list is not held for what they may add.
PROBES_S = 2
# The largest whole number JSON and JavaScript hold exactly: past it the page would show another
# number than the one stored.
MAX_WHOLE = 2**53 - 1

UNREADABLE = "The list of models could not be read."

LABELS: dict[str, str] = {
    "anthropic": "Anthropic", "openrouter": "OpenRouter", "openai": "OpenAI", "groq": "Groq",
    "mistral": "Mistral", "ollama": "Ollama", "lmstudio": "LM Studio", "llamacpp": "llama.cpp",
    "koboldcpp": "KoboldCpp",
}
# Where each local server waits when it is left as it was installed.
_LOCAL_DEFAULTS: dict[str, Family] = {
    "http://localhost:11434/v1": "ollama",
    "http://localhost:1234/v1": "lmstudio",
    "http://localhost:8080/v1": "llamacpp",
    "http://localhost:5001/v1": "koboldcpp",
}
# OpenAI's list says nothing of what a model does: these are the ids of models that cannot chat,
# and that, ticked, would make AIs that fail at every reply.
_OPENAI_NOT_CHAT = ("embed", "tts", "whisper", "dall-e", "image", "moderation", "transcribe", "audio")
_NUM_CTX = re.compile(r"^\s*num_ctx\s+(\d+)\s*$", re.MULTILINE)
_DIGITS = re.compile(r"[0-9]{1,20}")


@dataclass(frozen=True)
class Listed:
    id: str
    name: str | None          # the server's display name, if it gives one
    vendor: str | None        # OpenRouter's "Vendor: " prefix; else the id before its first "/"; else None
    created: int | None       # seconds since 1970, when the server says
    served: int | None        # what the server has loaded, or serves (a hosted model's window)
    configured: int | None    # what it is set to load (Ollama's num_ctx)
    max: int | None           # the trained maximum, never what a local server loaded
    max_output: int | None
    # OpenRouter's own `reasoning` object as it gave it, for the least reasoning a memory pass
    # asks; never relayed to the page.
    reasoning: dict | None
    price_in: float | None    # USD per million tokens; 0.0 is free
    price_out: float | None
    price_cache_read: float | None
    price_cache_write: float | None
    price_varies: bool        # a negative price: the service picks the model (OpenRouter's routers)
    reasons: bool | None
    chats: bool               # False for what cannot answer in a conversation
    batch: bool               # a ":batch" copy: counted in `dropped`


@dataclass(frozen=True)
class Catalog:
    family: Family
    read_at: str              # ISO time of the read (from the cache: when it was read)
    models: list[Listed]      # every model the server lists, in its order, none left out


# Values


def whole(value: object) -> int | None:
    """A count a server gave: an int, a string of digits or a float with no fraction, above 0 and
    at most 2^53 - 1. Anything else is not told."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        number = value
    elif isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            return None
        number = int(value)
    elif isinstance(value, str) and _DIGITS.fullmatch(value.strip()):
        number = int(value.strip())
    else:
        return None
    return number if 0 < number <= MAX_WHOLE else None


def _decimal(value: object) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, str | int | float):
        return None
    try:
        number = Decimal(str(value).strip())
    except InvalidOperation:
        return None
    return number if number.is_finite() else None


def per_million(value: object) -> float | None:
    """A server's price per token, as USD per million tokens. Counted in decimal, so that
    "0.000003" is 3.0 and not 2.9999999. A negative price is not one: None."""
    number = _decimal(value)
    if number is None or number < 0:
        return None
    result = float(number * 1_000_000)
    return result if math.isfinite(result) else None


def amount(value: object) -> float | None:
    """A price already in USD per million tokens, sent back by the page or typed: a finite
    number, 0 or more."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) and value >= 0 else None


def _text(value: object) -> str | None:
    # Every name leaves in the probe's answer: half an emoji would make its encoding fail.
    return well_formed(value) if isinstance(value, str) and value else None


# Families and addresses


def _bare(base_url: str) -> str:
    return (base_url or "").rstrip("/")


def guess_family(provider: str, base_url: str) -> Family:
    """The family an address names, as the update that made services decided it; else generic."""
    low = (base_url or "").lower()
    if provider == "anthropic" or "//api.anthropic.com" in low:
        return "anthropic"
    if "//openrouter.ai/" in low:
        return "openrouter"
    if "//api.openai.com" in low:
        return "openai"
    if "//api.groq.com/" in low:
        return "groq"
    if "//api.mistral.ai" in low:
        return "mistral"
    return _LOCAL_DEFAULTS.get(_bare(base_url), "generic")


def family_of(provider: str, base_url: str, stored: Family, family_url: str | None) -> Family:
    """The family an address names; else the one stored, as long as the address is still the
    one it was decided at; else generic, and the next read probes."""
    guessed = guess_family(provider, base_url)
    if guessed != "generic":
        return guessed
    if family_url is not None and _bare(base_url) == _bare(family_url):
        return stored
    return "generic"


def _host(base_url: str) -> str:
    try:
        return (urlsplit(base_url).hostname or "").lower()
    except ValueError:
        return ""


def _address(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def is_loopback(base_url: str) -> bool:
    """On this PC rather than elsewhere on the network."""
    host = _host(base_url)
    address = _address(host)
    return host == "localhost" or (address is not None and address.is_loopback)


def is_local(family: Family, base_url: str) -> bool:
    """A server at home rather than a paid service. Read from the address alone, never looked
    up: a name resolved at each list would cost a DNS request on every read."""
    if family in HOSTED_FAMILIES:
        return False
    host = _host(base_url)
    if not host:
        return False
    address = _address(host)
    if address is not None:
        return address.is_loopback or address.is_private or address.is_link_local
    return ("." not in host or host == "host.docker.internal"
            or host.endswith((".local", ".lan", ".home.arpa", ".internal", ".localhost")))


def root_of(base_url: str) -> str:
    """The server's own address, where its native routes live: base_url without its final /v1."""
    return _bare(base_url).removesuffix("/v1")


def service_name(family: Family, base_url: str, taken: set[str]) -> str:
    """The chip's label of a named family, else the address's host and port; numbered while
    another service holds the name."""
    name = LABELS.get(family)
    if name is None:
        try:
            parts = urlsplit(base_url)
            host, port = parts.hostname or "", parts.port
        except ValueError:
            host, port = "", None
        if ":" in host:
            host = f"[{host}]"
        name = (f"{host}:{port}" if port else host) or _bare(base_url)
    numbered, n = name, 1
    while numbered in taken:
        n += 1
        numbered = f"{name} ({n})"
    return numbered


def display_name(listed: Listed, family: Family) -> str:
    """OpenRouter's name without its "Vendor: " prefix; else the server's name; else the id
    after its last "/"."""
    if listed.name:
        if family == "openrouter" and ": " in listed.name:
            return listed.name.split(": ", 1)[1]
        return listed.name
    return listed.id.rsplit("/", 1)[-1]


# What the page receives


def relayed(catalog: Catalog) -> list[dict]:
    """What the page is sent of a list: every model that can chat, in the server's order. Some
    fields no row shows, so that the page can send back what it ticked with no second read."""
    return [{
        "id": m.id,
        "name": display_name(m, catalog.family),
        "vendor": m.vendor,
        "created": m.created,
        "context": {"served": m.served, "configured": m.configured, "max": m.max},
        "max_output": m.max_output,
        "price": {"input": m.price_in, "output": m.price_out, "varies": m.price_varies,
                  "cache_read": m.price_cache_read, "cache_write": m.price_cache_write},
        "reasons": m.reasons,
    } for m in catalog.models if m.chats]


def dropped(catalog: Catalog) -> dict:
    """What ``relayed`` leaves out and the page says, so that the count does not look short
    beside the service's own site."""
    return {"batch": sum(m.batch for m in catalog.models)}


# Reading a model as its server describes it


def _reasons_on_openrouter(entry: dict) -> bool | None:
    reasoning = entry.get("reasoning")
    if isinstance(reasoning, dict):
        if reasoning.get("mandatory") is True or reasoning.get("default_enabled") is True:
            return True
        if reasoning.get("default_enabled") is False:
            return False
        # Optional, and nothing says what it does when it is not asked.
        return None
    parameters = entry.get("supported_parameters")
    parameters = parameters if isinstance(parameters, list) else []
    # Taking the parameter does not say it reasons unless asked: learned at its first reply.
    if "reasoning" in parameters or "include_reasoning" in parameters:
        return None
    return False


def _listed(entry: dict, family: Family, provider: str) -> Listed | None:
    raw_id = entry.get("id")
    if isinstance(raw_id, bool) or not isinstance(raw_id, str | int) or raw_id == "":
        return None
    model_id = well_formed(str(raw_id))
    name = _text(entry.get("name"))
    vendor = None
    created = whole(entry.get("created"))
    served = configured = top = max_output = None
    reasons = None

    if provider == "anthropic":
        name = _text(entry.get("display_name"))
        served = whole(entry.get("max_input_tokens"))
        max_output = whole(entry.get("max_tokens"))
    else:
        for field in ("context_window", "max_context_length", "context_length", "max_model_len"):
            if served is None:
                served = whole(entry.get(field))
        max_output = whole(entry.get("max_completion_tokens"))
        meta = entry.get("meta")
        if isinstance(meta, dict):
            served = served or whole(meta.get("n_ctx"))
            top = whole(meta.get("n_ctx_train"))
    if family == "openrouter":
        provider_top = entry.get("top_provider")
        if isinstance(provider_top, dict):
            max_output = whole(provider_top.get("max_completion_tokens")) or max_output
        reasons = _reasons_on_openrouter(entry)
        if name and ": " in name:
            vendor = name.split(": ", 1)[0]
    if vendor is None and "/" in model_id:
        vendor = model_id.split("/", 1)[0] or None

    pricing = entry.get("pricing")
    pricing = pricing if isinstance(pricing, dict) else {}
    price_in, price_out = per_million(pricing.get("prompt")), per_million(pricing.get("completion"))
    varies = any((_decimal(pricing.get(key)) or 0) < 0 for key in ("prompt", "completion"))
    architecture = entry.get("architecture")
    outputs = architecture.get("output_modalities") if isinstance(architecture, dict) else None
    outputs = outputs if isinstance(outputs, list) else None
    # A model that also writes an image, a sound or a video and lists 0 is billed another way
    # than by the token: "free" would be wrong.
    if outputs and set(outputs) - {"text"} and price_in == 0 and price_out == 0:
        price_in = price_out = None

    batch = model_id.endswith(":batch")
    chats = not batch and (outputs is None or "text" in outputs)
    if family == "openai" and any(word in model_id.lower() for word in _OPENAI_NOT_CHAT):
        chats = False
    reasoning = entry.get("reasoning")
    return Listed(
        id=model_id, name=name, vendor=_text(vendor), created=created, served=served,
        configured=configured, max=top, max_output=max_output,
        reasoning=reasoning if isinstance(reasoning, dict) else None,
        price_in=price_in, price_out=price_out,
        price_cache_read=per_million(pricing.get("input_cache_read")),
        price_cache_write=per_million(pricing.get("input_cache_write")),
        price_varies=varies, reasons=reasons, chats=chats, batch=batch)


# Requests


def client_factory() -> httpx.AsyncClient:
    """The one door of every catalog request: lists, OpenRouter's key, the native probes and
    Ollama's /api/show. The tests replace it."""
    return httpx.AsyncClient(timeout=LIST_DELAYS)


def _headers(service: dict) -> dict:
    # Imported here: the providers import this module.
    from . import get_provider

    return get_provider(service)._headers()


async def _body(response: httpx.Response) -> bytes:
    pieces, size = [], 0
    async for piece in response.aiter_bytes():
        size += len(piece)
        if size > LIST_MAX_BYTES:
            raise ProviderError("The list of models is too large to read.", MODEL_UNREADABLE)
        pieces.append(piece)
    return b"".join(pieces)


async def _fetch(client: httpx.AsyncClient, url: str, headers: dict, base_url: str, *,
                 method: str = "GET", params: dict | None = None,
                 body: dict | None = None) -> tuple[int, bytes]:
    try:
        async with client.stream(method, url, headers=headers, params=params, json=body,
                                 timeout=LIST_DELAYS) as response:
            return response.status_code, await _body(response)
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        raise lost(exc, base_url)


async def _page(client: httpx.AsyncClient, url: str, headers: dict, service: dict,
                params: dict | None = None) -> dict:
    """One answer of a list, as an object; any failure as the server said it."""
    base_url = _bare(service.get("base_url"))
    status, body = await _fetch(client, url, headers, base_url, params=params)
    if status >= 400:
        raise _refusal(status, body, service.get("api_key"))
    return _object(body)


def _object(body: bytes) -> dict:
    try:
        data = json.loads(body)
    except ValueError:
        raise ProviderError(UNREADABLE, MODEL_UNREADABLE)
    if not isinstance(data, dict):
        raise ProviderError(UNREADABLE, MODEL_UNREADABLE)
    return data


def _entries(page: dict, key: str = "data") -> list[dict]:
    entries = page.get(key)
    if entries is None:
        return []
    if not isinstance(entries, list):
        raise ProviderError(UNREADABLE, MODEL_UNREADABLE)
    return [entry for entry in entries if isinstance(entry, dict)]


def _ids(entries: list[dict]) -> set[str]:
    return {str(entry.get("id")) for entry in entries if entry.get("id") not in (None, "")}


async def _openrouter_list(client, base: str, headers: dict, service: dict) -> list[dict]:
    """Every page of OpenRouter's list. Its default page is 500 models and the most it gives is
    1,000: an address that pages one way or the other is followed to its end, never in a loop."""
    url = base + "/models"
    params = {"limit": 1000, "offset": 0}
    status, body = await _fetch(client, url, headers, base, params=params)
    if status == 400:
        # A server in OpenRouter's place that does not take the parameters: its list as it is.
        return _entries(await _page(client, url, headers, service))
    if status >= 400:
        raise _refusal(status, body, service.get("api_key"))
    page = _object(body)
    split = urlsplit(base)
    origin = f"{split.scheme}://{split.netloc}"
    entries: list[dict] = []
    seen: set[str] = set()
    followed: set[str] = set()
    while True:
        got = _entries(page)
        new = _ids(got) - seen
        if not new:
            break
        entries += got
        seen |= new
        links = page.get("links")
        if isinstance(links, dict):
            following = links.get("next")
            if not isinstance(following, str) or not following:
                break
            # Against the origin, never after base_url, and never to another host: the key
            # goes with every request.
            target = urljoin(origin + "/", following)
            there = urlsplit(target)
            if f"{there.scheme}://{there.netloc}" != origin or target in followed:
                break
            followed.add(target)
            page = await _page(client, target, headers, service)
        else:
            params = {"limit": 1000, "offset": params["offset"] + len(got)}
            page = await _page(client, url, headers, service, params)
    return entries


async def _key_refused(client, base: str, headers: dict, service: dict) -> ProviderError | None:
    """OpenRouter's list is public and takes any key: its /key says whether this one is good.
    Only a 401 says no; anything else, or no answer, says nothing."""
    try:
        status, body = await _fetch(client, base + "/key", headers, base)
    except ProviderError:
        return None
    return _refusal(status, body, service.get("api_key")) if status == 401 else None


async def _anthropic_list(client, base: str, headers: dict, service: dict) -> list[dict]:
    """Every page of Anthropic's list (20 a page unless asked, 1,000 at most)."""
    url = base + "/v1/models"
    params: dict = {"limit": 1000}
    entries: list[dict] = []
    after = None
    while True:
        page = await _page(client, url, headers, service, params)
        got = _entries(page)
        entries += got
        last = page.get("last_id") or (got[-1].get("id") if got else None)
        if page.get("has_more") is not True or not got or not last or last == after:
            break
        after = last
        params = {"limit": 1000, "after_id": last}
    return entries


async def _the_list(client, service: dict, family: Family, headers: dict) -> list[dict]:
    base = _bare(service.get("base_url"))
    if service.get("provider") == "anthropic":
        return await _anthropic_list(client, base, headers, service)
    if family != "openrouter":
        return _entries(await _page(client, base + "/models", headers, service))
    checking = asyncio.ensure_future(_key_refused(client, base, headers, service))
    try:
        entries = await _openrouter_list(client, base, headers, service)
        # Asked alongside the list, and waited for a moment past it, never longer.
        done, _ = await asyncio.wait({checking}, timeout=PROBES_S)
        refusal = checking.result() if done else None
    finally:
        await _stop(checking)
    if refusal is not None:
        raise refusal
    return entries


async def _stop(*tasks: asyncio.Future) -> None:
    """Cancels what has not answered, and waits for it to let go of the client."""
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


# The native probes of local servers


def _lmstudio_shape(data: object) -> list[dict] | None:
    if not isinstance(data, dict):
        return None
    models = data["models"] if "models" in data else data.get("data")
    if not isinstance(models, list) or not models:
        return None
    if not all(isinstance(m, dict) and (m.get("key") or m.get("id")) and m.get("type")
               for m in models):
        return None
    return models


def _ollama_shape(data: object) -> list | None:
    if isinstance(data, dict) and isinstance(data.get("models"), list):
        return data["models"]
    return None


def _llamacpp_shape(data: object) -> dict | None:
    if isinstance(data, dict) and isinstance(data.get("default_generation_settings"), dict):
        return data["default_generation_settings"]
    return None


def _koboldcpp_shape(data: object) -> int | None:
    if isinstance(data, dict):
        data = data.get("value")
    return whole(data) if isinstance(data, int) and not isinstance(data, bool) else None


# Each family's own routes, from the most precise answer to the loosest.
_PROBES: dict[str, tuple[tuple[str, ...], Callable]] = {
    "lmstudio": (("/api/v1/models", "/api/v0/models"), _lmstudio_shape),
    "ollama": (("/api/ps",), _ollama_shape),
    "llamacpp": (("/props",), _llamacpp_shape),
    "koboldcpp": (("/api/extra/true_max_context_length",), _koboldcpp_shape),
}


async def _probe(client, root: str, paths: tuple[str, ...], shape: Callable, headers: dict):
    """What a family's own route says, in its own shape; None for anything else. Never raises."""
    for path in paths:
        try:
            status, body = await _fetch(client, root + path, headers, root)
            told = shape(json.loads(body)) if status == 200 else None
        except (ProviderError, ValueError):
            told = None
        if told is not None:
            return told
    return None


async def _natives(client, family: Family, service: dict, headers: dict) -> tuple[Family, object]:
    """The family's own probe, or, for a generic address, every family's, one request each, all
    under one delay. The family whose probe answered in its shape, and what it said."""
    families = list(_PROBES) if family == "generic" else [family] if family in _PROBES else []
    if not families:
        return family, None
    # A generic address is asked once per family: LM Studio's older route only when it is known.
    root = root_of(service.get("base_url"))
    tasks = {
        name: asyncio.ensure_future(_probe(
            client, root, _PROBES[name][0][:1] if family == "generic" else _PROBES[name][0],
            _PROBES[name][1], headers))
        for name in families}
    try:
        await asyncio.wait(tasks.values(), timeout=PROBES_S)
    finally:
        await _stop(*tasks.values())
    for name in families:
        task = tasks[name]
        if task.done() and not task.cancelled() and task.result() is not None:
            return name, task.result()
    return family, None


def _with_natives(models: list[Listed], family: Family, told: object) -> list[Listed]:
    if told is None:
        return models
    if family == "lmstudio":
        native = {str(m.get("key") or m.get("id")): m for m in told}
        out = []
        for model in models:
            entry = native.get(model.id)
            if entry is None:
                out.append(model)
            elif entry.get("type") != "llm":
                # An embedding model, installed with LM Studio: it cannot answer.
                out.append(replace(model, chats=False))
            else:
                out.append(_lmstudio_model(model, entry))
        return out
    if family == "ollama":
        loaded = {}
        for entry in told:
            if isinstance(entry, dict):
                for key in ("name", "model"):
                    if isinstance(entry.get(key), str):
                        loaded.setdefault(entry[key], whole(entry.get("context_length")))
        return [replace(m, served=loaded.get(m.id) or m.served) for m in models]
    if family == "llamacpp":
        # One model served at a time, at the slot size it was started with.
        size = whole(told.get("n_ctx"))
        return [replace(m, served=m.served or size) for m in models]
    if family == "koboldcpp":
        return [replace(m, served=told) for m in models]
    return models


def _lmstudio_model(model: Listed, entry: dict) -> Listed:
    served = None
    for instance in entry.get("loaded_instances") or []:
        config = instance.get("config") if isinstance(instance, dict) else None
        if isinstance(config, dict) and (served := whole(config.get("context_length"))):
            break
    capabilities = entry.get("capabilities")
    reasoning = capabilities.get("reasoning") if isinstance(capabilities, dict) else None
    reasons = None
    if reasoning not in (None, False) and not (
            isinstance(reasoning, dict) and reasoning.get("default") == "off"):
        reasons = True
    return replace(model, name=model.name or _text(entry.get("display_name")),
                   served=served or model.served,
                   max=whole(entry.get("max_context_length")) or model.max,
                   reasons=reasons if reasons is not None else model.reasons)


# The cache


@dataclass(frozen=True)
class _Kept:
    at: float
    catalog: Catalog
    probed: bool


# Per API type, address and key: never the service's id (a draft has none yet, and a memory pass
# only knows its call). In memory only, never on the disk.
_cache: dict[tuple[str, str, str], _Kept] = {}
_now = time.monotonic


def cache_key(service: dict) -> tuple[str, str, str]:
    key = service.get("api_key") or ""
    return (service.get("provider") or "", _bare(service.get("base_url")),
            hashlib.sha256(key.encode("utf-8", "surrogatepass")).hexdigest())


async def read_catalog(service: dict, *, probes: bool = True, fresh: bool = False,
                       max_age: float = 600, client_factory=None) -> Catalog:
    """The models a service's server lists, with what it says of each.

    probes=False reads the list alone. fresh=True skips the list kept from an earlier read;
    max_age is how old that one may be for this caller, in seconds: ten minutes for what a person
    looks at (OpenRouter's list weighs 850 KB on the PC's link), more for a memory pass. A failed
    read is never kept. client_factory: None takes this module's door; a provider passes its own.
    """
    key = cache_key(service)
    kept = _cache.get(key)
    if (not fresh and kept is not None and _now() - kept.at < max_age
            and (kept.probed or not probes)):
        return kept.catalog
    factory = client_factory if client_factory is not None else globals()["client_factory"]
    try:
        async with asyncio.timeout(LIST_WHOLE_S):
            read = await _read(service, probes, factory)
    except TimeoutError:
        raise ProviderError(
            f"The list of models of {_bare(service.get('base_url'))} did not come within "
            f"{LIST_WHOLE_S} seconds.", LIST_TIMEOUT)
    _cache[key] = _Kept(_now(), read, probes)
    return read


async def _read(service: dict, probes: bool, factory) -> Catalog:
    provider = service.get("provider") or ""
    base_url = service.get("base_url") or ""
    family = family_of(provider, base_url, service.get("family") or "generic",
                       service.get("family_url"))
    headers = _headers(service)
    async with factory() as client:
        natives = asyncio.ensure_future(_natives(client, family, service, headers)) if probes \
            else None
        try:
            entries = await _the_list(client, service, family, headers)
            learned, told = await natives if natives is not None else (family, None)
        finally:
            if natives is not None:
                await _stop(natives)
    models: list[Listed] = []
    seen: set[str] = set()
    for entry in entries:
        listed = _listed(entry, learned, provider)
        # The same id twice: the first is kept.
        if listed is not None and listed.id not in seen:
            seen.add(listed.id)
            models.append(listed)
    models = _with_natives(models, learned, told)
    return Catalog(family=learned, read_at=datetime.now(UTC).isoformat(timespec="seconds"),
                   models=models)


async def read_one(service: dict, model_id: str, *, fresh: bool = False,
                   client_factory=None) -> tuple[Listed | None, Family]:
    """One model as its server describes it: the list (kept, unless fresh), the probes when the
    service is generic, and, for Ollama, its /api/show for this one model alone. None when the
    server no longer lists it; with the family learned."""
    read = await read_catalog(service, fresh=fresh, client_factory=client_factory)
    listed = next((m for m in read.models if m.id == model_id), None)
    if listed is None or read.family != "ollama":
        return listed, read.family
    factory = client_factory if client_factory is not None else globals()["client_factory"]
    root = root_of(service.get("base_url") or "")
    try:
        async with factory() as client, asyncio.timeout(PROBES_S):
            status, body = await _fetch(client, root + "/api/show", _headers(service), root,
                                        method="POST", body={"model": model_id})
        shown = json.loads(body) if status == 200 else None
    except (ProviderError, ValueError, TimeoutError):
        shown = None
    if not isinstance(shown, dict):
        return listed, read.family
    top = None
    info = shown.get("model_info")
    if isinstance(info, dict):
        top = next((whole(value) for key, value in info.items()
                    if isinstance(key, str) and key.endswith(".context_length")), None)
    configured = None
    parameters = shown.get("parameters")
    if isinstance(parameters, str) and (found := _NUM_CTX.search(parameters)):
        configured = whole(found.group(1))
    return replace(listed, configured=configured or listed.configured,
                   max=top or listed.max), read.family
