"""Endpoints for message variants (alternates / swipes)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.repositories.variant_repository import VariantRepository
from app.models.variant import VariantCreate, VariantResponse

router = APIRouter(prefix="/messages/{message_id}/variants", tags=["variants"])


def _get_repo() -> VariantRepository:
    return VariantRepository()


@router.get("", response_model=list[VariantResponse])
async def list_variants(
    message_id: str,
    repo: VariantRepository = Depends(_get_repo),
) -> list[VariantResponse]:
    """List all variants (alternates) for a given message."""
    return await repo.list_by_message(message_id)


@router.post("", response_model=VariantResponse, status_code=201)
async def create_variant(
    message_id: str,
    data: VariantCreate,
    repo: VariantRepository = Depends(_get_repo),
) -> VariantResponse:
    """Add a new variant for a message."""
    if data.message_id != message_id:
        raise HTTPException(status_code=400, detail="message_id mismatch")
    return await repo.create(data)


@router.post("/{variant_id}/select", response_model=VariantResponse)
async def select_variant(
    variant_id: str,
    repo: VariantRepository = Depends(_get_repo),
) -> VariantResponse:
    """Mark a variant as the selected one (deselects siblings)."""
    variant = await repo.select(variant_id)
    if variant is None:
        raise HTTPException(status_code=404, detail="Variant not found")
    return variant


@router.delete("/{variant_id}", status_code=204)
async def delete_variant(
    variant_id: str,
    repo: VariantRepository = Depends(_get_repo),
) -> None:
    """Delete a variant."""
    deleted = await repo.delete(variant_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Variant not found")
