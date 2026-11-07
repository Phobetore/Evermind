-- The connection used when a conversation names none was kept in two places: the mark on the
-- connection, and a setting that Settings wrote. Where the setting names a connection that still
-- exists, that one takes the mark from the others. The setting goes either way.
UPDATE connections
SET is_default = ('"' || id || '"' = (SELECT value FROM settings WHERE key = 'default_connection_id'))
WHERE EXISTS (
    SELECT 1 FROM settings s JOIN connections c ON s.value = '"' || c.id || '"'
    WHERE s.key = 'default_connection_id'
);

DELETE FROM settings WHERE key = 'default_connection_id';
