-- Counts the changes to a conversation's messages, which a page compares with what it shows.
ALTER TABLE conversations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER message_added AFTER INSERT ON messages BEGIN
  UPDATE conversations SET revision = revision + 1 WHERE id = NEW.conversation_id;
END;
CREATE TRIGGER message_changed AFTER UPDATE OF variants, active_index, meta ON messages BEGIN
  UPDATE conversations SET revision = revision + 1 WHERE id = NEW.conversation_id;
END;
CREATE TRIGGER message_removed AFTER DELETE ON messages BEGIN
  UPDATE conversations SET revision = revision + 1 WHERE id = OLD.conversation_id;
END;
