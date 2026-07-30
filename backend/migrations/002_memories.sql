CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'fact',
    content TEXT NOT NULL,
    source_position INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'auto',
    created_at TEXT NOT NULL
);
CREATE INDEX idx_memories_conversation ON memories(conversation_id, is_pinned DESC, created_at);

ALTER TABLE conversations ADD COLUMN memory_position INTEGER NOT NULL DEFAULT 0;
