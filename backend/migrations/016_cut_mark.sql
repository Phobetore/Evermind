-- 3.0.x marked a reply cut short only while it had one version, so the cut is its first.
UPDATE messages
SET meta = json_set(json_remove(meta, '$.streaming'), '$.interrupted', json_array(0))
WHERE json_type(meta, '$.interrupted') = 'true' OR json_type(meta, '$.streaming') = 'true';
