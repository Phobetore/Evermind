-- Migration 002 — Memory system
-- Creates memories and world_state tables for the v0.2 memory pipeline.

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('semantic', 'episodic', 'world')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  entities TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.8,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_referenced_at TEXT,
  source_turn_id TEXT,
  FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_state (
  character_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memories_character_type
  ON memories(character_id, type);

CREATE INDEX IF NOT EXISTS idx_memories_character_active
  ON memories(character_id, is_deleted);
