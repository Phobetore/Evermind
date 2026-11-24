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

-- The three settings that were the way of playing, read once: as they are stored (JSON), or
-- their defaults when never touched. Nothing writes them any more; the release before still
-- reads them, so they stay. A value that is not JSON (written by hand) counts as untouched:
-- json_extract would stop the whole update on it.
CREATE TEMP TABLE before_ways AS SELECT
    COALESCE((SELECT json_extract(value, '$') FROM settings
              WHERE key = 'reply_length' AND json_valid(value)), 'medium') AS reply_length,
    COALESCE((SELECT json_extract(value, '$') FROM settings
              WHERE key = 'history_limit' AND json_valid(value)), 24) AS history_limit,
    COALESCE((SELECT json_extract(value, '$') FROM settings
              WHERE key = 'passage_budget' AND json_valid(value)), 1500) AS passage_budget;

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
