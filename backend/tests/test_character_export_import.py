"""Tests for character export/import endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient


@pytest.mark.asyncio
async def test_export_character(client: AsyncClient) -> None:
    # Create a character
    resp = await client.post("/characters", json={"name": "ExportHero", "summary": "A brave hero"})
    assert resp.status_code == 201
    char_id = resp.json()["id"]

    # Export it
    resp = await client.get(f"/characters/{char_id}/export")
    assert resp.status_code == 200
    export = resp.json()
    assert export["version"] == "1"
    assert export["character"]["name"] == "ExportHero"
    assert export["character"]["summary"] == "A brave hero"
    # Should not contain server-side fields
    assert "id" not in export["character"]
    assert "created_at" not in export["character"]
    assert "updated_at" not in export["character"]


@pytest.mark.asyncio
async def test_export_character_not_found(client: AsyncClient) -> None:
    resp = await client.get("/characters/nonexistent-id/export")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_import_character(client: AsyncClient) -> None:
    payload = {
        "version": "1",
        "character": {
            "name": "ImportedChar",
            "tags": ["imported", "test"],
            "summary": "Imported from JSON",
            "persona": "Mysterious",
        },
    }
    resp = await client.post("/characters/import", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "ImportedChar"
    assert "imported" in data["tags"]
    assert data["id"]  # Should have a new ID


@pytest.mark.asyncio
async def test_import_character_roundtrip(client: AsyncClient) -> None:
    """Export then import should produce an equivalent character."""
    # Create original
    resp = await client.post(
        "/characters",
        json={
            "name": "RoundTrip",
            "tags": ["a", "b"],
            "summary": "Test roundtrip",
            "persona": "Cheerful",
            "writing_style": "Casual",
            "scenario": "At the beach",
            "first_message": "Hey!",
            "boundaries": "Keep it friendly",
        },
    )
    assert resp.status_code == 201
    original = resp.json()

    # Export
    resp = await client.get(f"/characters/{original['id']}/export")
    assert resp.status_code == 200
    export_data = resp.json()

    # Import
    resp = await client.post("/characters/import", json=export_data)
    assert resp.status_code == 201
    imported = resp.json()

    # Should be equivalent (except id/timestamps)
    assert imported["name"] == original["name"]
    assert imported["tags"] == original["tags"]
    assert imported["summary"] == original["summary"]
    assert imported["persona"] == original["persona"]
    assert imported["id"] != original["id"]


@pytest.mark.asyncio
async def test_import_invalid_format(client: AsyncClient) -> None:
    resp = await client.post("/characters/import", json={"invalid": "data"})
    assert resp.status_code == 422
