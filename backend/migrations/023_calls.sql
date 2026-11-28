-- Every request Evermind sends to a model's server, one row each: inserted when it starts
-- (outcome 'running', the prompt as the engine estimates it), completed when it ends, however it
-- ends. No foreign key and no cascade, on purpose: money spent on a conversation, a card or an AI
-- stays spent once they are deleted, so ids are plain TEXT (32-hex, uuid4().hex) and names are
-- copied at call time. Instants are UTC ISO with milliseconds ("…T14:03:05.123+00:00"), so that
-- they sort as text.
CREATE TABLE calls (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    purpose TEXT NOT NULL CHECK (purpose IN ('reply', 'regenerate', 'continue', 'pen', 'memory',
                                             'consolidation', 'card', 'speed')),
    -- The try's number within one turn: 0, then 1, 2 for each pass that asks again by itself.
    attempt INTEGER NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'whole', 'stopped',
                                             'failed', 'refused', 'empty', 'discarded')),
    -- The error status of a refused or failed call; NULL when the server was never reached.
    status INTEGER,
    conversation_id TEXT,
    conversation_title TEXT,
    card_id TEXT,
    card_name TEXT,
    card_kind TEXT CHECK (card_kind IN ('character', 'scenario')),
    -- The card assistant's job, so that a new card's first save claims what writing it cost.
    job_id TEXT,
    message_id TEXT,
    variant INTEGER,
    model_id TEXT,
    model_name TEXT,
    service_id TEXT,
    service_name TEXT,
    family TEXT,
    -- At home and with no price: never money, shown under "Free". loopback: on this PC rather
    -- than elsewhere on the network, kept here since the service may move or go.
    local INTEGER NOT NULL DEFAULT 0 CHECK (local IN (0, 1)),
    loopback INTEGER NOT NULL DEFAULT 0 CHECK (loopback IN (0, 1)),
    model_asked TEXT,
    model_served TEXT,
    upstream TEXT,
    generation_id TEXT,
    -- tokens_in is the whole prompt, cache included; tokens_out includes the reasoning.
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    tokens_cached INTEGER,
    tokens_cache_write INTEGER,
    tokens_reasoning INTEGER,
    tokens_source TEXT NOT NULL DEFAULT 'estimated'
        CHECK (tokens_source IN ('server', 'estimated', 'mixed')),
    -- USD per million tokens as applied, copied at call time.
    price_in REAL,
    price_out REAL,
    price_cache_read REAL,
    price_cache_write REAL,
    price_source TEXT CHECK (price_source IN ('read', 'typed', 'typed_later')),
    -- cost: what the service charged (reported) or what its price makes (computed); with a key of
    -- one's own on OpenRouter, what the original service billed goes to cost_upstream.
    cost REAL,
    cost_upstream REAL,
    cost_source TEXT NOT NULL DEFAULT 'none' CHECK (cost_source IN ('reported', 'computed', 'none')),
    currency TEXT NOT NULL DEFAULT 'USD',
    -- The server's usage object as it came, no content: what a later reading may need.
    usage_raw TEXT,
    reconciled_at TEXT
);
CREATE INDEX calls_started ON calls (started_at);
CREATE INDEX calls_model ON calls (model_id, started_at);
CREATE INDEX calls_card ON calls (card_id, started_at);
CREATE INDEX calls_conversation ON calls (conversation_id, started_at);
CREATE INDEX calls_outcome ON calls (outcome);
CREATE INDEX calls_job ON calls (job_id) WHERE job_id IS NOT NULL;

-- Nothing was noted before this update: Spending says it counts from here.
INSERT INTO settings (key, value)
VALUES ('spending_since', json_quote(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '+00:00'))
ON CONFLICT(key) DO NOTHING;
