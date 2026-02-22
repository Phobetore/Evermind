"""Benchmark endpoints — create, list, inspect, and delete benchmark runs."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.repositories.benchmark_repository import BenchmarkRepository
from app.models.benchmark import BenchmarkRunCreate, BenchmarkRunResponse, BenchmarkScoreResponse

router = APIRouter(prefix="/benchmarks", tags=["benchmarks"])


def _get_repo() -> BenchmarkRepository:
    return BenchmarkRepository()


@router.get("", response_model=list[BenchmarkRunResponse])
async def list_benchmark_runs(
    character_id: str | None = None,
    repo: BenchmarkRepository = Depends(_get_repo),
) -> list[BenchmarkRunResponse]:
    """List benchmark runs, optionally filtered by character."""
    return await repo.list_runs(character_id=character_id)


@router.post("", response_model=BenchmarkRunResponse, status_code=201)
async def create_benchmark_run(
    data: BenchmarkRunCreate,
    repo: BenchmarkRepository = Depends(_get_repo),
) -> BenchmarkRunResponse:
    """Create a new benchmark run with status 'pending'."""
    return await repo.create_run(data.character_id, data.profile_id)


@router.get("/{run_id}", response_model=BenchmarkRunResponse)
async def get_benchmark_run(
    run_id: str,
    repo: BenchmarkRepository = Depends(_get_repo),
) -> BenchmarkRunResponse:
    """Get a single benchmark run by ID."""
    run = await repo.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Benchmark run not found")
    return run


@router.get("/{run_id}/report")
async def get_benchmark_report(
    run_id: str,
    repo: BenchmarkRepository = Depends(_get_repo),
) -> dict:
    """Return the full benchmark report: run metadata + all per-turn scores."""
    run = await repo.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Benchmark run not found")
    scores = await repo.get_scores(run_id)
    return {
        "run": run.model_dump(),
        "scores": [s.model_dump() for s in scores],
    }


@router.delete("/{run_id}", status_code=204)
async def delete_benchmark_run(
    run_id: str,
    repo: BenchmarkRepository = Depends(_get_repo),
) -> None:
    """Delete a benchmark run and its associated scores."""
    deleted = await repo.delete_run(run_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Benchmark run not found")


@router.get("/{run_id}/scores", response_model=list[BenchmarkScoreResponse])
async def list_benchmark_scores(
    run_id: str,
    repo: BenchmarkRepository = Depends(_get_repo),
) -> list[BenchmarkScoreResponse]:
    """List all per-turn scores for a benchmark run."""
    run = await repo.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Benchmark run not found")
    return await repo.get_scores(run_id)
