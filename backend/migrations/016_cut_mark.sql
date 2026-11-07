-- A reply cut short says which of its versions were, from the first write of one to its last. A
-- reply left mid-write said "streaming" until the next turn settled it, and an older one said only
-- "interrupted": true, which read as the version on screen.
UPDATE messages
SET meta = json_set(json_remove(meta, '$.streaming'), '$.interrupted', json_array(active_index))
WHERE json_type(meta, '$.interrupted') = 'true' OR json_type(meta, '$.streaming') = 'true';
