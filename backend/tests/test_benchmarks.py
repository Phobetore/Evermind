"""Tests for benchmark endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_and_list_benchmark_runs(client: AsyncClient) -> None:
    # Create a character first
    char_resp = await client.post("/characters", json={"name": "BenchChar"})
    cid = char_resp.json()["id"]

    # Create a benchmark run
    resp = await client.post(
        "/benchmarks", json={"character_id": cid, "profile_id": "balanced"}
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["character_id"] == cid
    assert body["profile_id"] == "balanced"
    assert body["status"] == "pending"
    assert body["id"]

    # List all runs
    resp = await client.get("/benchmarks")
    assert resp.status_code == 200
    runs = resp.json()
    assert any(r["id"] == body["id"] for r in runs)

    # List filtered by character
    resp = await client.get(f"/benchmarks?character_id={cid}")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1


@pytest.mark.asyncio
async def test_get_benchmark_run(client: AsyncClient) -> None:
    char_resp = await client.post("/characters", json={"name": "BenchChar2"})
    cid = char_resp.json()["id"]
    create_resp = await client.post(
        "/benchmarks", json={"character_id": cid, "profile_id": "fast"}
    )
    run_id = create_resp.json()["id"]

    resp = await client.get(f"/benchmarks/{run_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == run_id


@pytest.mark.asyncio
async def test_get_benchmark_run_not_found(client: AsyncClient) -> None:
    resp = await client.get("/benchmarks/nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_benchmark_report(client: AsyncClient) -> None:
    char_resp = await client.post("/characters", json={"name": "BenchChar3"})
    cid = char_resp.json()["id"]
    create_resp = await client.post(
        "/benchmarks", json={"character_id": cid, "profile_id": "balanced"}
    )
    run_id = create_resp.json()["id"]

    resp = await client.get(f"/benchmarks/{run_id}/report")
    assert resp.status_code == 200
    report = resp.json()
    assert "run" in report
    assert "scores" in report
    assert report["run"]["id"] == run_id
    assert report["scores"] == []


@pytest.mark.asyncio
async def test_delete_benchmark_run(client: AsyncClient) -> None:
    char_resp = await client.post("/characters", json={"name": "BenchChar4"})
    cid = char_resp.json()["id"]
    create_resp = await client.post(
        "/benchmarks", json={"character_id": cid, "profile_id": "fast"}
    )
    run_id = create_resp.json()["id"]

    resp = await client.delete(f"/benchmarks/{run_id}")
    assert resp.status_code == 204

    # Verify gone
    resp = await client.get(f"/benchmarks/{run_id}")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_benchmark_run_not_found(client: AsyncClient) -> None:
    resp = await client.delete("/benchmarks/nonexistent")
    assert resp.status_code == 404
