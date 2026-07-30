"""Semantic ranking of facts against the current scene."""

import numpy as np

from app.prompting import embeddings, retrieval


def test_cosine_scores_orders_by_similarity():
    query = [1.0, 0.0]
    matrix = np.array([[1.0, 0.0], [0.0, 1.0], [0.7071, 0.7071]], dtype=np.float32)
    scores = retrieval._cosine_scores(query, matrix)
    assert scores[0] > scores[2] > scores[1]  # identical > 45deg > orthogonal
    assert round(scores[0], 3) == 1.0
    assert round(scores[1], 3) == 0.0


def test_cosine_scores_empty_matrix():
    assert retrieval._cosine_scores([1.0, 0.0], np.empty((0, 2), dtype=np.float32)) == []


async def test_rank_scores_by_query_relevance(monkeypatch):
    # two facts: one aligned with the query vector, one orthogonal
    emb_map = {
        "aligned": embeddings.pack([1.0, 0.0]),
        "orthogonal": embeddings.pack([0.0, 1.0]),
    }

    async def fake_embed(texts, kind):
        assert kind == "query"
        return [[1.0, 0.0]]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    scores = await retrieval.rank("the current scene", emb_map)
    assert scores["aligned"] > scores["orthogonal"]


async def test_rank_none_when_no_embeddings(monkeypatch):
    async def fake_embed(texts, kind):
        return [[1.0, 0.0]]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    assert await retrieval.rank("scene", {}) is None


async def test_rank_none_when_query_embed_fails(monkeypatch):
    async def fake_embed(texts, kind):
        return None

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    assert await retrieval.rank("scene", {"a": embeddings.pack([1.0, 0.0])}) is None


async def test_rank_survives_corrupt_blob(monkeypatch):
    async def fake_embed(texts, kind):
        return [[1.0, 0.0]]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    # 'bad' has a byte length that doesn't unpack to a matching-width vector
    emb_map = {"ok": embeddings.pack([1.0, 0.0]), "bad": b"\x01\x02\x03"}
    scores = await retrieval.rank("the current scene", emb_map)
    assert scores is None  # degraded gracefully, no exception


def test_select_passages_orders_and_budgets():
    from app.prompting.retrieval import select_passages
    ranked = {"a": 0.9, "b": 0.2, "c": 0.95}
    candidates = [
        {"id": "a", "content": "mot " * 10, "position": 3, "role": "user"},
        {"id": "b", "content": "mot " * 10, "position": 5, "role": "assistant"},
        {"id": "c", "content": "mot " * 10, "position": 1, "role": "user"},
    ]
    # generous budget: all three fit, displayed oldest-first
    kept = select_passages(ranked, candidates, token_budget=10_000)
    assert [p["position"] for p in kept] == [1, 3, 5]
    # tiny budget fits ~one: the highest-scored ('c', 0.95) wins
    kept_one = select_passages(ranked, candidates, token_budget=12)
    assert kept_one == [] or kept_one[0]["id"] == "c"


def test_select_passages_excludes_positions():
    from app.prompting.retrieval import select_passages
    ranked = {"a": 0.9, "b": 0.8}
    candidates = [
        {"id": "a", "content": "x", "position": 3, "role": "user"},
        {"id": "b", "content": "y", "position": 7, "role": "assistant"},
    ]
    kept = select_passages(ranked, candidates, token_budget=10_000, exclude_positions={3})
    assert [p["id"] for p in kept] == ["b"]  # position 3 already covered by a fact


def test_select_passages_empty_ranked():
    from app.prompting.retrieval import select_passages
    assert select_passages({}, [{"id": "a", "content": "x", "position": 1, "role": "user"}], 100) == []
