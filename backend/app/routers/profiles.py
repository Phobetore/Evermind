"""Profiles endpoint — list and update generation profiles."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.config import get_config
from app.models.profile import ProfileResponse, ProfileUpdate

router = APIRouter(prefix="/profiles", tags=["profiles"])


@router.get("", response_model=list[ProfileResponse])
async def list_profiles() -> list[ProfileResponse]:
    """Return all profiles from config.yaml."""
    cfg = get_config()
    return [
        ProfileResponse(
            id=pid,
            chat_server=p.chat_server,
            memory_server=p.memory_server,
            judge_server=p.judge_server,
            best_of_n=p.best_of_n,
            self_refine=p.self_refine,
        )
        for pid, p in cfg.profiles.items()
    ]


@router.put("/{profile_id}", response_model=ProfileResponse)
async def update_profile(profile_id: str, data: ProfileUpdate) -> ProfileResponse:
    """Update a generation profile in memory (changes are not persisted to config.yaml)."""
    cfg = get_config()
    profile = cfg.profiles.get(profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"Profile '{profile_id}' not found")

    allowed_fields = {"chat_server", "memory_server", "judge_server", "best_of_n", "self_refine"}
    updates = data.model_dump(exclude_unset=True)
    for key, value in updates.items():
        if key in allowed_fields:
            setattr(profile, key, value)

    return ProfileResponse(
        id=profile_id,
        chat_server=profile.chat_server,
        memory_server=profile.memory_server,
        judge_server=profile.judge_server,
        best_of_n=profile.best_of_n,
        self_refine=profile.self_refine,
    )


@router.get("/llm-servers", response_model=dict[str, str])
async def list_llm_servers() -> dict[str, str]:
    """Return a mapping of server key → model name (filename stem from model_path)."""
    cfg = get_config()
    return {
        name: Path(srv.model_path).stem
        for name, srv in cfg.llm_servers.items()
    }
