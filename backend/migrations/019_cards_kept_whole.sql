-- The card a character was imported from, whole, as its file held it: what Evermind does not read
-- of it survives an export. In a table of its own, so that the list of characters stays light.
CREATE TABLE character_cards (
    character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('png', 'json')),
    -- What Evermind made of the card, as it stored it: the export writes over the card only what
    -- differs from this, so a later change of the reading rules never passes for an edit.
    read TEXT NOT NULL,
    -- The PNG's other card chunk, when it held a second card that reads differently: never lost.
    other_text TEXT,
    read_at TEXT NOT NULL
);
-- 1: the rules every card had before cards were kept whole; 2: the rules community cards are
-- written for. Every card already here keeps 1, until its owner accepts to re-read it.
ALTER TABLE characters ADD COLUMN card_rules INTEGER NOT NULL DEFAULT 1 CHECK (card_rules IN (1, 2));
ALTER TABLE characters ADD COLUMN nickname TEXT NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN character_note TEXT NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN character_note_depth INTEGER NOT NULL DEFAULT 4 CHECK (character_note_depth >= 0);
ALTER TABLE characters ADD COLUMN character_note_role TEXT NOT NULL DEFAULT 'system'
    CHECK (character_note_role IN ('system', 'user', 'assistant'));
ALTER TABLE characters ADD COLUMN creator_notes_multilingual TEXT NOT NULL DEFAULT '{}';
-- Which entry of the kept card an entry comes from, by its index there; NULL for one made here.
ALTER TABLE lore_entries ADD COLUMN origin INTEGER;
ALTER TABLE lore_entries ADD COLUMN comment TEXT NOT NULL DEFAULT '';
ALTER TABLE lore_entries ADD COLUMN constant INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lore_entries ADD COLUMN selective INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lore_entries ADD COLUMN secondary_keys TEXT NOT NULL DEFAULT '[]';
ALTER TABLE lore_entries ADD COLUMN selective_logic INTEGER NOT NULL DEFAULT 0 CHECK (selective_logic BETWEEN 0 AND 3);
ALTER TABLE lore_entries ADD COLUMN insertion_order INTEGER NOT NULL DEFAULT 100;
-- SillyTavern's numbering, kept as read: 0 before the definition, 1 after, 4 at a depth, 7 a named outlet.
ALTER TABLE lore_entries ADD COLUMN position INTEGER NOT NULL DEFAULT 1 CHECK (position BETWEEN 0 AND 7);
ALTER TABLE lore_entries ADD COLUMN depth INTEGER NOT NULL DEFAULT 4 CHECK (depth >= 0);
ALTER TABLE lore_entries ADD COLUMN role TEXT NOT NULL DEFAULT 'system' CHECK (role IN ('system', 'user', 'assistant'));
ALTER TABLE lore_entries ADD COLUMN whole_words INTEGER NOT NULL DEFAULT 1;
ALTER TABLE lore_entries ADD COLUMN exclude_recursion INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lore_entries ADD COLUMN prevent_recursion INTEGER NOT NULL DEFAULT 0;
-- An entry already here is placed where it was: its order is its rank in its lorebook.
UPDATE lore_entries SET insertion_order = (
    SELECT COUNT(*) FROM lore_entries AS earlier
    WHERE earlier.character_id = lore_entries.character_id
      AND (earlier.created_at, earlier.rowid) < (lore_entries.created_at, lore_entries.rowid));
