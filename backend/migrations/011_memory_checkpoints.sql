-- A summary is only as true as the story it was written from. Cutting a story back,
-- by removing messages from a point on or by branching at one, has to give the
-- conversation the summary it had at that point, and say how far its facts had been
-- read then, so that the next pass reads exactly what was lost and nothing is rebuilt
-- from the last few turns.
--
-- One row each time the memory writes a summary: `position` is the turn it covers up
-- to, and `memory_position` how far the facts had been read when it was written. For a
-- pass the two are the same; a summary asked for reads turns without drawing facts from
-- them, so its row has the position of the last message and the memory's own. A later
-- row at the same position replaces the earlier.
CREATE TABLE memory_checkpoints (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    summary TEXT NOT NULL,
    memory_position INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, position)
);

-- Messages removed from a point on used to leave the memory's position where it was, and
-- new turns then waited to pass it before anything was read. A conversation in that state
-- is brought back to its last message: the position cannot be later than the story is.
UPDATE conversations
SET memory_position = MIN(
    memory_position,
    COALESCE((SELECT MAX(position) FROM messages WHERE messages.conversation_id = conversations.id), 0)
)
WHERE memory_position > 0;

-- What the memory has read has a summary, which is the one the conversation holds: it is
-- the checkpoint to go back to for a cut before the next pass writes another. A
-- conversation the memory never read has none, and its summary, if it has one, is its owner's.
INSERT INTO memory_checkpoints (conversation_id, position, summary, memory_position)
SELECT id, memory_position, COALESCE(summary, ''), memory_position
FROM conversations
WHERE memory_position > 0;
