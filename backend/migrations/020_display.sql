-- What a conversation shows behind its text. 'auto': the character's picture, when this device
-- shows pictures; 'image': its own wallpaper; 'none': nothing, whatever the device says.
ALTER TABLE conversations ADD COLUMN backdrop TEXT NOT NULL DEFAULT 'auto'
    CHECK (backdrop IN ('auto', 'none', 'image'));
-- Its own strength, 0 to 1; NULL follows the device's.
ALTER TABLE conversations ADD COLUMN backdrop_strength REAL
    CHECK (backdrop_strength IS NULL OR backdrop_strength BETWEEN 0 AND 1);
-- A wallpaper chosen before keeps its picture and the strength it was shown at.
UPDATE conversations SET backdrop = 'image',
    backdrop_strength = MIN(MAX(wallpaper_opacity, 0), 1)
    WHERE wallpaper_path <> '';
-- The smaller copies of a portrait, made by a browser: '' until one has sent them.
ALTER TABLE characters ADD COLUMN avatar_thumb_path TEXT NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN avatar_backdrop_path TEXT NOT NULL DEFAULT '';
-- What a card shows of its description when it has no tagline; NULL until worked out again.
ALTER TABLE characters ADD COLUMN excerpt TEXT;
-- The version of the rule that wrote it (card_text.EXCERPT_RULE): a new rule works every
-- excerpt out again, with no migration.
ALTER TABLE characters ADD COLUMN excerpt_rule INTEGER NOT NULL DEFAULT 0;
