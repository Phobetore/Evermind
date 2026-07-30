"""Character Card V2 <-> internal character mapping.

Spec: https://github.com/malfoyslastname/character-card-spec-v2
Internal field names follow the `characters` table. Evermind-specific fields
(kind, tagline) travel in `data.extensions.evermind` so exports stay lossless.
"""

_CARD_TO_CHAR = {
    "name": "name",
    "description": "description",
    "personality": "personality",
    "scenario": "scenario",
    "first_mes": "greeting",
    "mes_example": "example_dialogues",
    "creator_notes": "creator_notes",
    "system_prompt": "system_prompt",
    "post_history_instructions": "post_history_instructions",
    "creator": "creator",
    "character_version": "character_version",
}


def character_to_card(char: dict, lore_entries: list[dict] | None = None) -> dict:
    data = {card_key: str(char.get(char_key) or "") for card_key, char_key in _CARD_TO_CHAR.items()}
    data["alternate_greetings"] = list(char.get("alternate_greetings") or [])
    data["tags"] = list(char.get("tags") or [])
    data["extensions"] = {
        "evermind": {
            "kind": char.get("kind") or "character",
            "tagline": str(char.get("tagline") or ""),
        }
    }
    if lore_entries:
        data["character_book"] = {
            "entries": [
                {
                    "keys": list(entry.get("keys") or []),
                    "content": str(entry.get("content") or ""),
                    "enabled": bool(entry.get("enabled", True)),
                    "case_sensitive": bool(entry.get("case_sensitive", False)),
                    "insertion_order": int(entry.get("priority") or 0),
                    "extensions": {},
                }
                for entry in lore_entries
            ]
        }
    return {"spec": "chara_card_v2", "spec_version": "2.0", "data": data}


def card_to_lore_entries(card: dict) -> list[dict]:
    """Extract V2 character_book entries as internal lore fields."""
    data = card.get("data") if isinstance(card.get("data"), dict) else card
    book = data.get("character_book")
    if not isinstance(book, dict):
        return []
    entries = []
    for raw in book.get("entries") or []:
        if not isinstance(raw, dict):
            continue
        keys = [str(k) for k in raw.get("keys") or [] if str(k).strip()]
        content = str(raw.get("content") or "").strip()
        if not keys or not content:
            continue
        entries.append({
            "keys": keys,
            "content": content,
            "enabled": bool(raw.get("enabled", True)),
            "case_sensitive": bool(raw.get("case_sensitive", False)),
            "priority": int(raw.get("insertion_order") or raw.get("priority") or 0),
        })
    return entries


def card_to_character(card: dict, kind: str | None = None) -> dict:
    """Accepts V2 (wrapped in `data`) and V1 (flat) cards."""
    data = card.get("data") if isinstance(card.get("data"), dict) else card
    evermind = {}
    extensions = data.get("extensions")
    if isinstance(extensions, dict) and isinstance(extensions.get("evermind"), dict):
        evermind = extensions["evermind"]

    char = {char_key: str(data.get(card_key) or "") for card_key, char_key in _CARD_TO_CHAR.items()}
    char["name"] = char["name"].strip() or "Unnamed"
    char["alternate_greetings"] = [
        str(g) for g in data.get("alternate_greetings") or [] if str(g).strip()
    ]
    char["tags"] = [str(t) for t in data.get("tags") or [] if str(t).strip()]
    resolved_kind = kind or evermind.get("kind") or "character"
    char["kind"] = resolved_kind if resolved_kind in ("character", "scenario") else "character"
    char["tagline"] = str(evermind.get("tagline") or "")
    return char
