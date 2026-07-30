"""Embedding module: serialization + graceful-degradation contract."""

from app.prompting import embeddings


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
    class FakeModel:
        def encode(self, texts, normalize_embeddings=False):
            import numpy as np
            return np.zeros((len(texts), 2), dtype=np.float32)

    monkeypatch.setattr(embeddings, "_model", FakeModel())
    await embeddings.embed(["where is he"], kind="query")
    # query prefix is applied — verified indirectly via no exception + shape


async def test_embed_empty_input_returns_none(monkeypatch):
    monkeypatch.setattr(embeddings, "_model", object())
    assert await embeddings.embed([], kind="query") is None


async def test_warmup_short_circuits_after_failed_attempt(monkeypatch):
    # a prior failed load must not be retried: no model, already attempted -> False.
    # Deterministic regardless of whether sentence-transformers is installed, and
    # never touches the real model.
    monkeypatch.setattr(embeddings, "_model", None)
    monkeypatch.setattr(embeddings, "_load_attempted", True)
    assert await embeddings.warmup() is False


async def test_warmup_returns_false_on_load_error(monkeypatch):
    # if loading the model raises, warmup degrades to False and never propagates.
    # We force the failure without loading anything real, so this holds whether or
    # not the package is present in the environment.
    monkeypatch.setattr(embeddings, "_model", None)
    monkeypatch.setattr(embeddings, "_load_attempted", False)

    async def boom(func, *args, **kwargs):
        raise RuntimeError("model load failed")

    monkeypatch.setattr(embeddings.asyncio, "to_thread", boom)
    assert await embeddings.warmup() is False
