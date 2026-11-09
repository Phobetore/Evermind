-- A session is now an HMAC of its token keyed by the password: the digests kept before
-- open nothing, so each device signs in once more. gate_state stays, for the password's
-- own digest, which the next start finds in its old form and writes anew.
DROP TABLE gate_sessions;
CREATE TABLE gate_sessions (token_hash TEXT PRIMARY KEY);
