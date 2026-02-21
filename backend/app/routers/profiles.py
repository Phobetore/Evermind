"""Profiles endpoint — list configured generation profiles."""

from __future__ import annotations

from fastapi import APIRouter

from app.config import get_config
from app.models.profile import ProfileResponse

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
