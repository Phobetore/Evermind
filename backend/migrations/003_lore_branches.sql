CREATE TABLE lore_entries (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    keys TEXT NOT NULL DEFAULT '[]',
    content TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    case_sensitive INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_lore_character ON lore_entries(character_id, priority DESC);

ALTER TABLE conversations ADD COLUMN forked_from TEXT;
ALTER TABLE conversations ADD COLUMN forked_at_position INTEGER;
