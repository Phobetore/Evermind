-- A backdrop for one conversation, and how strongly it shows through. Stored
-- per conversation rather than per character on purpose: the same character in
-- two different stories is two different places.
--
-- The default is low. A backdrop competes with the text sitting on it, and
-- someone who has just chosen an image should see their conversation still
-- readable rather than have to rescue it.
ALTER TABLE conversations ADD COLUMN wallpaper_path TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN wallpaper_opacity REAL NOT NULL DEFAULT 0.25;
