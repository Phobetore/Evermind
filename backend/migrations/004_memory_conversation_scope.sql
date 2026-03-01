-- Migration 004 — Scope memories per conversation
-- Adds conversation_id to memories so each conversation has its own memory pool.
-- ON DELETE CASCADE ensures memories are deleted when their conversation is removed.

ALTER TABLE memories ADD COLUMN conversation_id TEXT
  REFERENCES conversations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_memories_conversation
  ON memories(conversation_id);
