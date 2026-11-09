-- No screen ever set these. A lorebook entry now matches whatever the case, in the lorebook's
-- order; the index goes first, or the column it holds could not.
DROP INDEX idx_lore_character;
ALTER TABLE lore_entries DROP COLUMN case_sensitive;
ALTER TABLE lore_entries DROP COLUMN priority;
CREATE INDEX idx_lore_character ON lore_entries(character_id);
ALTER TABLE conversations DROP COLUMN forked_at_position;
