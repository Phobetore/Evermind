-- migrations/003_variants_benchmarks.sql
-- Adds message_variants, benchmark_runs and benchmark_scores tables for v1.0.

CREATE TABLE IF NOT EXISTS message_variants (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  content TEXT NOT NULL,
  score REAL,
  is_selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_variants_message
  ON message_variants(message_id);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  summary TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS benchmark_scores (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  persona_score REAL,
  memory_score REAL,
  continuity_score REAL,
  style_score REAL,
  immersion_score REAL,
  total_score REAL,
  details TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(run_id) REFERENCES benchmark_runs(id) ON DELETE CASCADE
);
