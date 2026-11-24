-- A server and its key (a "service" on screen) now hold several models, each one an "AI": the
-- key is kept once. The columns a connection held for its one model stay as they were at this
-- update and no code of this release reads or writes them: the release before still does, so
-- going back to it keeps working. A later release drops them.
ALTER TABLE connections ADD COLUMN family TEXT NOT NULL DEFAULT 'generic' CHECK (family IN
    ('ollama','lmstudio','llamacpp','koboldcpp','openrouter','openai','anthropic','groq','mistral','generic'));
-- The address the family was decided at: once the address changes (the release before still
-- writes it), the family no longer holds.
ALTER TABLE connections ADD COLUMN family_url TEXT;

CREATE TABLE models (
    id TEXT PRIMARY KEY,
    -- RESTRICT, not CASCADE: the release before still deletes connections, and its "Delete" on
    -- one of them must not take every AI of that service with it. This release removes the AIs
    -- first, then their service.
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
    model TEXT NOT NULL DEFAULT '',          -- the server's own id
    name TEXT NOT NULL,                      -- what the person sees
    is_default INTEGER NOT NULL DEFAULT 0,
    -- What it reads at once: typed (NULL = follow what was read), read, and how it was read.
    context_own INTEGER CHECK (context_own IS NULL OR context_own >= 512),
    context_read INTEGER CHECK (context_read IS NULL OR context_read > 0),
    context_read_kind TEXT CHECK (context_read_kind IN ('served','configured','observed','max')),
    output_read INTEGER CHECK (output_read IS NULL OR output_read > 0),
    reasons INTEGER CHECK (reasons IN (0, 1)),           -- NULL: not told
    price_in REAL, price_out REAL,                       -- USD per million tokens, read
    price_cache_read REAL, price_cache_write REAL,       -- read only (OpenRouter); the spending plan copies them per call
    price_varies INTEGER NOT NULL DEFAULT 0,             -- read as negative: the service picks the model
    price_own_in REAL, price_own_out REAL,               -- typed, used when none was read
    limits_read_at TEXT,
    reply_cap_mode TEXT NOT NULL DEFAULT 'auto' CHECK (reply_cap_mode IN ('auto','unsent','fixed')),
    reply_cap_tokens INTEGER CHECK (reply_cap_tokens IS NULL OR reply_cap_tokens >= 1),
    temperature REAL, top_p REAL, frequency_penalty REAL, presence_penalty REAL,
    -- Measured by the plan that counts what a server reports (plan 3); empty until then.
    token_ratio REAL, token_ratio_n INTEGER NOT NULL DEFAULT 0, fit_margin REAL, reply_tokens_avg TEXT,
    -- Made from a connection by this update: its figures may now work against it, which is said.
    migrated INTEGER NOT NULL DEFAULT 0,
    notices_kept INTEGER NOT NULL DEFAULT 0,             -- "keep everything as it is" was chosen
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (reply_cap_mode <> 'fixed' OR reply_cap_tokens IS NOT NULL)
);
CREATE INDEX idx_models_connection ON models(connection_id);

-- Every connection becomes an AI with the same id, in the same order: the oldest stays the
-- default when none is marked. Its window is kept as typed (16384 cannot be told from a typed
-- 16384). The API never stored one under 1024; a row written by hand may hold less: a 0 was read
-- as 8192 by the engine and stays 8192; between 1 and 511 the engine's budget was already its
-- floor of 512, so 512 sends the same request (only meta.context's figure moves). A ceiling
-- becomes "fixed", an empty one "unsent" (Anthropic then still sends 4096, as before); one under
-- 1 could not have produced a reply and is not sent.
INSERT INTO models (id, connection_id, model, name, is_default, context_own, reply_cap_mode,
    reply_cap_tokens, temperature, top_p, frequency_penalty, presence_penalty, migrated,
    created_at, updated_at)
SELECT id, id, model, name, is_default,
    CASE WHEN context_size >= 512 THEN context_size WHEN context_size > 0 THEN 512 ELSE 8192 END,
    CASE WHEN max_tokens IS NULL OR max_tokens < 1 THEN 'unsent' ELSE 'fixed' END,
    CASE WHEN max_tokens >= 1 THEN max_tokens END,
    temperature, top_p, frequency_penalty, presence_penalty, 1, created_at, updated_at
FROM connections ORDER BY rowid;

-- One service per server and key: the oldest connection of each group holds it.
UPDATE models SET connection_id = (
    SELECT s.id FROM connections AS s, connections AS c
    WHERE c.id = models.id AND s.provider = c.provider
      AND rtrim(s.base_url, '/') = rtrim(c.base_url, '/') AND s.api_key = c.api_key
    ORDER BY s.created_at, s.rowid LIMIT 1);
DELETE FROM connections WHERE id NOT IN (SELECT connection_id FROM models);

-- The release before answers a conversation that names no connection with the one marked
-- default: when that one was merged, the service that now holds the default AI takes the mark
-- (a frozen column, written for the release before only).
UPDATE connections SET is_default = 1
WHERE id = (SELECT connection_id FROM models WHERE is_default = 1 ORDER BY created_at, rowid
            LIMIT 1);

-- A known address names the service after its chip; anything else keeps the oldest row's name
-- and is told apart by the probes at the first read.
UPDATE connections SET
    family_url = rtrim(base_url, '/'),
    family = CASE
        WHEN provider = 'anthropic' OR base_url LIKE '%//api.anthropic.com%' THEN 'anthropic'
        WHEN base_url LIKE '%//openrouter.ai/%' THEN 'openrouter'
        WHEN base_url LIKE '%//api.openai.com%' THEN 'openai'
        WHEN base_url LIKE '%//api.groq.com/%' THEN 'groq'
        WHEN base_url LIKE '%//api.mistral.ai%' THEN 'mistral'
        WHEN rtrim(base_url, '/') = 'http://localhost:11434/v1' THEN 'ollama'
        WHEN rtrim(base_url, '/') = 'http://localhost:1234/v1' THEN 'lmstudio'
        WHEN rtrim(base_url, '/') = 'http://localhost:8080/v1' THEN 'llamacpp'
        WHEN rtrim(base_url, '/') = 'http://localhost:5001/v1' THEN 'koboldcpp'
        ELSE 'generic' END;
UPDATE connections SET name = CASE family
    WHEN 'anthropic' THEN 'Anthropic' WHEN 'openrouter' THEN 'OpenRouter' WHEN 'openai' THEN 'OpenAI'
    WHEN 'groq' THEN 'Groq' WHEN 'mistral' THEN 'Mistral' WHEN 'ollama' THEN 'Ollama'
    WHEN 'lmstudio' THEN 'LM Studio' WHEN 'llamacpp' THEN 'llama.cpp' WHEN 'koboldcpp' THEN 'KoboldCpp'
    ELSE name END;

-- Today's form named a connection after its chip ("OpenRouter"): two AIs would show one name
-- twice, beside a service of that name, and rows never show the model's id. An AI named after
-- its service's chip (a known family: a "generic" service took its own oldest row's name, which
-- is the person's, never a chip's), or after another AI, takes its model's id after the last "/"
-- (the rtrim/replace pair cuts up to the last "/"; a "/" at the end is dropped first, and an id
-- with nothing but "/" gives no name, so its row keeps its own); names still shared then get
-- " (2)", " (3)": a name the person chose keeps it bare, a derived name takes the number, then
-- creation order. A number so added can meet a name the person chose that already ends in it
-- ("brume (2)"): those two AIs then share a name, which the AI's page can change. Done before
-- the services are numbered, so that it compares with the chip's label itself. The rows are
-- chosen before any is renamed, so the order of the update cannot change the result.
CREATE TEMP TABLE renamed AS SELECT m.id, rtrim(m.model, '/') AS bare FROM models AS m
WHERE rtrim(m.model, '/') <> '' AND (
    m.name IN (SELECT name FROM connections
               WHERE connections.id = m.connection_id AND connections.family <> 'generic')
    OR m.name IN (SELECT o.name FROM models AS o WHERE o.id <> m.id));
UPDATE models SET name = (SELECT replace(bare, rtrim(bare, replace(bare, '/', '')), '')
                          FROM renamed WHERE renamed.id = models.id)
WHERE id IN (SELECT id FROM renamed);
UPDATE models SET name = models.name || ' (' || r.n || ')'
FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY name
          ORDER BY id IN (SELECT id FROM renamed), created_at, rowid) AS n
      FROM models) AS r
WHERE r.id = models.id AND r.n > 1;
DROP TABLE renamed;

-- Two keys on one server are two services: the later ones get a number.
UPDATE connections SET name = connections.name || ' (' || r.n || ')'
FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at, rowid) AS n
      FROM connections) AS r
WHERE r.id = connections.id AND r.n > 1;

-- A conversation names its AI. One that named none, or one gone, is pinned to the one that
-- answers it today (the marked default, else the oldest), as connections.resolve did.
ALTER TABLE conversations ADD COLUMN model_id TEXT REFERENCES models(id) ON DELETE SET NULL;
-- The name of an AI removed while this conversation used it, until the line saying so is seen.
ALTER TABLE conversations ADD COLUMN model_lost TEXT;
UPDATE conversations SET model_id = COALESCE(
    (SELECT id FROM models WHERE id = conversations.connection_id),
    (SELECT id FROM models ORDER BY is_default DESC, created_at, rowid LIMIT 1));
-- The frozen column must not point at a row this update removed: the release before would
-- fail to copy such a conversation into a branch (a foreign key checked on insert).
UPDATE conversations SET connection_id = NULL
WHERE connection_id IS NOT NULL AND connection_id NOT IN (SELECT id FROM connections);
