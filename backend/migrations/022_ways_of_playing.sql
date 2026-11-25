-- How a conversation is played: a way of playing, by id (the four built in are light, balanced,
-- immersive, maximum; others are kept in settings.play_styles), and what this conversation
-- changed of it for itself (JSON: history_limit, reply_length, reminders), NULL for nothing.
-- Read by the engine call: an id no longer known plays the way offered to new conversations,
-- then balanced, never empty values.
ALTER TABLE conversations ADD COLUMN play_style TEXT NOT NULL DEFAULT 'balanced';
ALTER TABLE conversations ADD COLUMN play_overrides TEXT;
-- Whether the AI's server says what it counts: NULL before its first whole reply, 0 when it
-- answered without, 1 once it said. Evermind keeps a wider margin for one that never says.
ALTER TABLE models ADD COLUMN usage_seen INTEGER CHECK (usage_seen IN (0, 1));

-- The three settings that were the way of playing, read once as 3.7 read and played them, so
-- that each plays as it did: never set, their defaults (medium, 24, 1500). Nothing writes them
-- any more; the release before still reads them, so they stay. 3.7 took a stored value as JSON
-- (one that is not JSON, or a JSON null, as nothing at all); a length it did not know played
-- medium; a count went through Python's int(value or 0): nothing, false, "", [] and {} gave 0
-- (no limit, or no passages), true 1, a fraction its whole part, a number written as text that
-- number. A count it could not read stopped every turn: that one plays balanced's figure, as
-- does a negative history (which reread no message at all). Past what JSON and JavaScript hold
-- exactly, a history rereads the whole story (0) and passages fit all they can.
CREATE TEMP TABLE before_ways_raw AS
SELECT key, value AS stored,
       CASE WHEN json_valid(value) THEN json_type(value) END AS type,
       CASE WHEN json_valid(value) THEN CASE WHEN json_type(value) = 'text'
            THEN trim(json_extract(value, '$'), ' ' || char(9, 10, 11, 12, 13)) END END AS text
FROM settings WHERE key IN ('history_limit', 'passage_budget');

CREATE TEMP TABLE before_ways_read AS
SELECT key, CASE
    -- Not JSON reads as nothing, but Python reads these three as numbers int() refuses.
    WHEN type IS NULL THEN CASE WHEN trim(stored, ' ' || char(9, 10, 11, 12, 13))
                                     IN ('NaN', 'Infinity', '-Infinity') THEN NULL ELSE 0 END
    WHEN type IN ('null', 'false') THEN 0
    WHEN type = 'true' THEN 1
    WHEN type IN ('integer', 'real') THEN CAST(json_extract(stored, '$') AS INTEGER)
    WHEN type = 'text' THEN CASE
        WHEN json_extract(stored, '$') = '' THEN 0
        WHEN text <> '' AND CASE WHEN substr(text, 1, 1) IN ('+', '-') THEN substr(text, 2)
                                 ELSE text END NOT GLOB '*[^0-9]*'
             AND CASE WHEN substr(text, 1, 1) IN ('+', '-') THEN substr(text, 2)
                      ELSE text END <> ''
        THEN CAST(text AS INTEGER)
        ELSE NULL END
    WHEN (SELECT COUNT(*) FROM json_each(stored)) = 0 THEN 0
    ELSE NULL END AS count
FROM before_ways_raw;

CREATE TEMP TABLE before_ways AS SELECT
    COALESCE((SELECT CASE WHEN json_valid(value) THEN CASE WHEN json_type(value) = 'text'
                          THEN CASE WHEN json_extract(value, '$') IN ('short', 'long')
                                    THEN json_extract(value, '$') END END END
              FROM settings WHERE key = 'reply_length'), 'medium') AS reply_length,
    COALESCE((SELECT CASE WHEN count IS NULL OR count < 0 THEN 24
                          WHEN count > 9007199254740991 THEN 0 ELSE count END
              FROM before_ways_read WHERE key = 'history_limit'), 24) AS history_limit,
    COALESCE((SELECT CASE WHEN count IS NULL THEN 1500 WHEN count < 0 THEN 0
                          ELSE MIN(count, 9007199254740991) END
              FROM before_ways_read WHERE key = 'passage_budget'), 1500) AS passage_budget;

-- Untouched, they are "balanced" figure for figure. Touched, they become a way of their own,
-- "mine" (its name is the interface's, in each language), offered to new conversations. Its
-- reply room is its length's (512, 1024, 2048): an AI that Evermind sets keeps the room it had,
-- and one that is sent no ceiling keeps 1024 whatever the way (ai_call.UNSENT_RESERVE).
INSERT INTO settings (key, value)
SELECT 'default_play_style', json_quote(CASE
        WHEN reply_length = 'medium' AND history_limit = 24 AND passage_budget = 1500
        THEN 'balanced' ELSE 'mine' END)
FROM before_ways;
INSERT INTO settings (key, value)
SELECT 'play_styles', json_object('overrides', json_object(), 'custom', CASE
        WHEN reply_length = 'medium' AND history_limit = 24 AND passage_budget = 1500
        THEN json_array()
        ELSE json_array(json_object(
            'id', 'mine', 'name', NULL,
            'history_limit', history_limit, 'reply_length', reply_length,
            'reply_room', CASE reply_length WHEN 'short' THEN 512 WHEN 'long' THEN 2048 ELSE 1024 END,
            'facts_cap', 2000, 'max_facts', 60, 'lore_cap', 800, 'lore_share', NULL,
            'passage_cap', passage_budget, 'passage_share', NULL))
        END)
FROM before_ways;

-- Every conversation plays as it did: the way that now holds the old settings.
UPDATE conversations SET play_style =
    (SELECT json_extract(value, '$') FROM settings WHERE key = 'default_play_style');
DROP TABLE before_ways;
DROP TABLE before_ways_read;
DROP TABLE before_ways_raw;
