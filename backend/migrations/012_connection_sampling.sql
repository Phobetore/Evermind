-- A generation setting left empty (NULL) is not sent, so the model's own value applies: the
-- newest models refuse some of them. Connections to OpenAI and Anthropic are emptied, but for
-- the ceiling Anthropic requires. extra_params, which no screen ever set, goes.
ALTER TABLE connections RENAME COLUMN max_tokens TO old_max_tokens;
ALTER TABLE connections RENAME COLUMN temperature TO old_temperature;
ALTER TABLE connections RENAME COLUMN top_p TO old_top_p;
ALTER TABLE connections RENAME COLUMN frequency_penalty TO old_frequency_penalty;
ALTER TABLE connections RENAME COLUMN presence_penalty TO old_presence_penalty;

ALTER TABLE connections ADD COLUMN max_tokens INTEGER;
ALTER TABLE connections ADD COLUMN temperature REAL;
ALTER TABLE connections ADD COLUMN top_p REAL;
ALTER TABLE connections ADD COLUMN frequency_penalty REAL;
ALTER TABLE connections ADD COLUMN presence_penalty REAL;

UPDATE connections SET max_tokens = old_max_tokens, temperature = old_temperature,
    top_p = old_top_p, frequency_penalty = old_frequency_penalty,
    presence_penalty = old_presence_penalty;

ALTER TABLE connections DROP COLUMN old_max_tokens;
ALTER TABLE connections DROP COLUMN old_temperature;
ALTER TABLE connections DROP COLUMN old_top_p;
ALTER TABLE connections DROP COLUMN old_frequency_penalty;
ALTER TABLE connections DROP COLUMN old_presence_penalty;
ALTER TABLE connections DROP COLUMN extra_params;

UPDATE connections SET max_tokens = CASE WHEN provider = 'anthropic' THEN max_tokens END,
    temperature = NULL, top_p = NULL, frequency_penalty = NULL, presence_penalty = NULL
WHERE provider = 'anthropic' OR base_url LIKE '%api.openai.com%';
