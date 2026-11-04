-- A summary is only as true as the story it was written from. Cutting a story back,
-- by removing messages from a point on or by branching at one, has to give the
-- conversation what it remembered at that point: the summary, how far its facts had been
-- read, and the facts as they stood, since a later pass may have corrected or dropped
-- them, so that the next pass reads exactly what was lost.
--
-- One row each time a pass ends, whether or not it wrote a summary, and each time a summary
-- is asked for: `position` is the turn it read up to, `summary` the one it wrote or else the
-- one the row before holds, and `memory_position` how far the facts had been read then. For
-- a pass the two positions are the same; a summary asked for reads turns without drawing
-- facts from them, so its row has the position of the last message and the memory's own. A
-- later row at the same position replaces the earlier.
--
-- Every statement can run again: this file is applied without a transaction, and a
-- process killed partway through runs it from the top on the next start.
CREATE TABLE IF NOT EXISTS memory_checkpoints (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    summary TEXT NOT NULL,
    memory_position INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, position)
);

-- The facts the model had written, by the id of the fact: what a person does to a fact
-- reaches its copies. A table and not a column of JSON, since that takes one statement
-- each where JSON would be read and rewritten, row by row, in every checkpoint.
CREATE TABLE IF NOT EXISTS memory_checkpoint_facts (
    conversation_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    fact_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    source_position INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, position, fact_id),
    FOREIGN KEY (conversation_id, position)
        REFERENCES memory_checkpoints(conversation_id, position) ON DELETE CASCADE
);

-- Messages removed from a point on used to leave the memory as it was. A conversation
-- with no message left, or none but its greeting, the ordinary shape of a story deleted back
-- to the start, and a memory that had read some, remembers a story that is gone: what the
-- model wrote of it goes. This comes before the position is repaired, which is what tells
-- such a conversation from one that never had a memory; a summary there may be someone's
-- own. A greeting says so in `meta`, in the one way the application has always written it.
UPDATE conversations SET summary = ''
WHERE memory_position > 0
  AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id
                  AND messages.meta NOT LIKE '%"greeting": true%');

DELETE FROM memories
WHERE source = 'auto' AND is_pinned = 0
  AND conversation_id IN (
    SELECT id FROM conversations
    WHERE memory_position > 0
      AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id
                      AND messages.meta NOT LIKE '%"greeting": true%'));

-- A conversation whose memory had read past its last message keeps its facts and its
-- summary. They may describe turns that went, and nothing can say which, but a pass reads
-- 40 turns at most: what they say of a long story cannot be read again, and the person can
-- see and correct them. Their position comes back to the end of the story, and so does the
-- memory's, or new turns would wait to pass the old mark before anything was read.
UPDATE memories
SET source_position = COALESCE(
    (SELECT MAX(position) FROM messages WHERE messages.conversation_id = memories.conversation_id), 0)
WHERE source_position > COALESCE(
    (SELECT MAX(position) FROM messages WHERE messages.conversation_id = memories.conversation_id), 0);

UPDATE conversations
SET memory_position = MIN(
    memory_position,
    COALESCE((SELECT MAX(position) FROM messages WHERE messages.conversation_id = conversations.id), 0)
)
WHERE memory_position > 0;

-- What the memory has read has a summary and facts, which are the ones the conversation
-- holds: they are the checkpoint to go back to for a cut before the next pass writes
-- another. A conversation the memory never read has none.
INSERT OR IGNORE INTO memory_checkpoints (conversation_id, position, summary, memory_position)
SELECT id, memory_position, COALESCE(summary, ''), memory_position
FROM conversations
WHERE memory_position > 0;

INSERT OR IGNORE INTO memory_checkpoint_facts
    (conversation_id, position, fact_id, kind, content, source_position)
SELECT c.id, c.memory_position, f.id, f.kind, f.content, f.source_position
FROM conversations c JOIN memories f ON f.conversation_id = c.id
WHERE c.memory_position > 0 AND f.source = 'auto';
