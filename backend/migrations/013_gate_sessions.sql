-- A session is now an HMAC of its token keyed by the password, which is no longer stored:
-- the digests kept before open nothing, so each device signs in once more.
DROP TABLE gate_state;
DROP TABLE gate_sessions;
CREATE TABLE gate_sessions (token_hash TEXT PRIMARY KEY);
