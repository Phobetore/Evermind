-- Migration 005 — User persona profiles
-- Users can create persona profiles with physical description, age, etc.
-- A conversation can optionally be linked to a persona (locked at creation).

CREATE TABLE IF NOT EXISTS user_personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  age TEXT NOT NULL DEFAULT '',
  physical_description TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  backstory TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  avatar_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE conversations ADD COLUMN user_persona_id TEXT DEFAULT NULL
  REFERENCES user_personas(id) ON DELETE SET NULL;
