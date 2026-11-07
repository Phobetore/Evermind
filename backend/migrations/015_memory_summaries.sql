-- A cut in the story takes the memory back to the summary of the last pass before it, kept
-- here, and a fact the model corrected since back to what it said. No copies of the facts.
DROP TABLE IF EXISTS memory_checkpoint_facts;
DROP TABLE IF EXISTS memory_checkpoints;
CREATE TABLE memory_summaries (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    summary TEXT NOT NULL,
    typed INTEGER NOT NULL DEFAULT 0,  -- by a person, which a cut keeps
    PRIMARY KEY (conversation_id, position)
);
ALTER TABLE memories ADD COLUMN previous_content TEXT;
ALTER TABLE memories ADD COLUMN corrected_at INTEGER;
ALTER TABLE memories DROP COLUMN kind;
-- A cut used to leave the memory as it was: what it read past the end of the story comes back.
UPDATE memories SET source_position = COALESCE(
    (SELECT MAX(position) FROM messages WHERE messages.conversation_id = memories.conversation_id), 0)
WHERE source_position > COALESCE(
    (SELECT MAX(position) FROM messages WHERE messages.conversation_id = memories.conversation_id), 0);
UPDATE conversations SET memory_position = MIN(memory_position,
    COALESCE((SELECT MAX(position) FROM messages WHERE messages.conversation_id = conversations.id), 0))
WHERE memory_position > 0;
-- Nothing tells a summary a person typed from a pass's: each stays theirs until the next pass.
INSERT INTO memory_summaries (conversation_id, position, summary, typed)
SELECT id, memory_position, summary, 1 FROM conversations WHERE memory_position > 0 OR summary <> '';
