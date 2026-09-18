-- Whole seconds cannot say which of two things happened first.
--
-- A message written in the same second somebody last read the room cannot be
-- placed either side of that read, and neither answer is good. Treating it as
-- read hides it for good: every later read pushes the mark further past it and
-- the count never mentions it again. Treating it as unread leaves a badge
-- showing one when you have just read everything, which clears only on the
-- next read in a later second.
--
-- So stop guessing. Milliseconds decide it, and two people posting inside one
-- millisecond is not a thing this agency will ever do.
--
-- The seconds stay where they are: created_at is what every other table here
-- uses, what the bell subtracts fourteen days from, and what the page polls
-- with. This is a tiebreak beside it, not a replacement for it.
ALTER TABLE messages ADD COLUMN created_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_members ADD COLUMN last_read_ms INTEGER NOT NULL DEFAULT 0;
