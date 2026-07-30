-- Per-conversation directive injected right before generation (post-history),
-- where instructions carry the most weight on long, context-full chats.
ALTER TABLE conversations ADD COLUMN author_note TEXT NOT NULL DEFAULT '';
