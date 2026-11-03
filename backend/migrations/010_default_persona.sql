-- The persona that conversations are played as was kept in two places: the mark
-- on the persona itself, and a setting of its own. They could disagree, and a
-- greeting then named one while the turns after it named the other. The mark is
-- the only one from now on.
--
-- The setting is where the choice was made in Settings, so where it names a
-- persona that still exists, that persona gets the mark and the others lose it.
-- The setting holds a JSON string, `"abc"` with its quotes; whatever else it
-- holds, or no longer names, it simply goes.
UPDATE personas SET is_default = 0
WHERE is_default = 1 AND EXISTS (
    SELECT 1 FROM settings s JOIN personas p
        ON p.id = CASE WHEN json_valid(s.value) THEN json_extract(s.value, '$') END
    WHERE s.key = 'default_persona_id'
);

UPDATE personas SET is_default = 1
WHERE id = (
    SELECT CASE WHEN json_valid(value) THEN json_extract(value, '$') END
    FROM settings WHERE key = 'default_persona_id'
);

DELETE FROM settings WHERE key = 'default_persona_id';
