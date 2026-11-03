-- The persona that conversations are played as was kept in two places: the mark
-- on the persona itself, and a setting of its own. They could disagree, and a
-- greeting then named one while the turns after it named the other. The mark is
-- the only one from now on.
--
-- The setting is where the choice was made in Settings, so where it names a
-- persona that still exists, that persona gets the mark and the others lose it.
-- The setting holds the id as JSON, which for the ids this application makes
-- (hexadecimal) is the id between double quotes; anything else it holds, or no
-- longer names, matches no persona, and the setting simply goes.
UPDATE personas SET is_default = 0
WHERE is_default = 1 AND EXISTS (
    SELECT 1 FROM settings s JOIN personas p ON s.value = '"' || p.id || '"'
    WHERE s.key = 'default_persona_id'
);

UPDATE personas SET is_default = 1
WHERE EXISTS (
    SELECT 1 FROM settings s
    WHERE s.key = 'default_persona_id' AND s.value = '"' || personas.id || '"'
);

DELETE FROM settings WHERE key = 'default_persona_id';

-- Nothing marked used to mean the oldest persona was played, so that is the one
-- that gets the mark, for whoever had deleted or unticked their default: they
-- keep the persona they were playing, and "None" is a choice open to them.
UPDATE personas SET is_default = 1
WHERE id = (SELECT id FROM personas ORDER BY created_at, rowid LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM personas WHERE is_default = 1);
