"""Embedding module: serialization + graceful-degradation contract."""

import re
import sys
import types
from pathlib import Path

from app.prompting import embeddings

ROOT = Path(__file__).resolve().parents[2]


class Hub:
    """sentence-transformers as Evermind sees it, never the real one: what it was asked for, and
    the cache, which holds the model once it has been downloaded."""

    def __init__(self, cached=False, broken=False):
        self.cached, self.broken, self.asked = cached, broken, []

    def module(self):
        hub = self

        class SentenceTransformer:
            def __init__(self, name, local_files_only=False):
                hub.asked.append("cache" if local_files_only else "huggingface.co")
                if hub.broken:
                    raise RuntimeError("this torch does not run here")
                if local_files_only and not hub.cached:
                    raise OSError("couldn't find them in the cached files")
                hub.cached = True

        module = types.ModuleType("sentence_transformers")
        module.SentenceTransformer = SentenceTransformer
        return module


async def start(monkeypatch, hub) -> bool:
    """One start of Evermind, which loads the model once."""
    monkeypatch.setitem(sys.modules, "sentence_transformers", hub.module())
    monkeypatch.setattr(embeddings, "_model", None)
    monkeypatch.setattr(embeddings, "_load_attempted", False)
    return await embeddings.warmup()


async def test_a_model_in_the_cache_loads_without_asking_huggingface(monkeypatch):
    hub = Hub(cached=True)

    assert await start(monkeypatch, hub)
    assert hub.asked == ["cache"]


async def test_the_model_is_downloaded_once_then_read_from_the_cache(monkeypatch):
    hub = Hub()

    assert await start(monkeypatch, hub)
    assert await start(monkeypatch, hub)
    assert hub.asked == ["cache", "huggingface.co", "cache"]


async def test_a_model_that_fails_for_another_reason_is_not_downloaded(monkeypatch):
    hub = Hub(cached=True, broken=True)

    assert not await start(monkeypatch, hub)
    assert hub.asked == ["cache"]


def test_the_image_keeps_the_model_in_the_data_volume():
    """Each update makes a new container: one that finds the model downloads nothing."""
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    data = re.search(r"EVERMIND_DATA_DIR=(\S+)", dockerfile)[1]
    cache = re.search(r"HF_HUB_CACHE=(\S+)", dockerfile)

    assert cache and cache[1].startswith(f"{data}/")
    assert f"evermind-data:{data}" in (ROOT / "docker-compose.yml").read_text(encoding="utf-8")


def test_the_model_in_the_volume_is_files_a_backup_can_copy_to_windows():
    """By default they are links, which Windows makes only as administrator or in Developer Mode."""
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

    assert re.search(r"\bHF_HUB_DISABLE_SYMLINKS=1\b", dockerfile)


def test_pack_unpack_round_trip():
    vector = [0.1, -0.5, 0.9, 0.0]
    blob = embeddings.pack(vector)
    assert isinstance(blob, bytes)
    back = embeddings.unpack(blob)
    assert [round(float(x), 4) for x in back] == [0.1, -0.5, 0.9, 0.0]


async def test_embed_returns_none_when_model_not_loaded(monkeypatch):
    monkeypatch.setattr(embeddings, "_model", None)
    assert await embeddings.embed(["bonjour"], kind="query") is None


async def test_embed_prefixes_and_returns_vectors(monkeypatch):
    captured = {}

    class FakeModel:
        def encode(self, texts, normalize_embeddings=False):
            captured["texts"] = texts
            captured["normalize"] = normalize_embeddings
            import numpy as np
            return np.array([[1.0, 0.0], [0.0, 1.0]][: len(texts)], dtype=np.float32)

    monkeypatch.setattr(embeddings, "_model", FakeModel())
    out = await embeddings.embed(["chat", "chien"], kind="passage")
    assert out == [[1.0, 0.0], [0.0, 1.0]]
    assert captured["texts"] == ["passage: chat", "passage: chien"]  # e5 prefix
    assert captured["normalize"] is True


async def test_embed_query_prefix(monkeypatch):
    captured = {}

    class FakeModel:
        def encode(self, texts, normalize_embeddings=False):
            captured["texts"] = texts
            import numpy as np
            return np.zeros((len(texts), 2), dtype=np.float32)

    monkeypatch.setattr(embeddings, "_model", FakeModel())
    await embeddings.embed(["where is he"], kind="query")
    assert captured["texts"] == ["query: where is he"]


async def test_embed_empty_input_returns_none(monkeypatch):
    monkeypatch.setattr(embeddings, "_model", object())
    assert await embeddings.embed([], kind="query") is None


async def test_warmup_short_circuits_after_failed_attempt(monkeypatch):
    # a prior failed load must not be retried: no model, already attempted -> False.
    # Deterministic regardless of whether sentence-transformers is installed, and
    # never touches the real model.
    monkeypatch.setattr(embeddings, "_model", None)
    monkeypatch.setattr(embeddings, "_load_attempted", True)
    warmed = await embeddings.warmup()
    assert warmed is False


async def test_warmup_returns_false_on_load_error(monkeypatch):
    # if loading the model raises, warmup degrades to False and never propagates.
    # We force the failure without loading anything real, so this holds whether or
    # not the package is present in the environment.
    monkeypatch.setattr(embeddings, "_model", None)
    monkeypatch.setattr(embeddings, "_load_attempted", False)

    async def boom(func, *args, **kwargs):
        raise RuntimeError("model load failed")

    monkeypatch.setattr(embeddings.asyncio, "to_thread", boom)
    warmed = await embeddings.warmup()
    assert warmed is False
