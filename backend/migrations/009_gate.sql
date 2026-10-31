-- Sessions of the access password: one per device, only a digest of the token is kept.
CREATE TABLE gate_sessions (
    token_hash   TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);
-- Digest of the password the sessions were opened with; a different password revokes them all.
CREATE TABLE gate_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL
);
