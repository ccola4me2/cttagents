-- "These two are not the same person", remembered.
--
-- The duplicates list matches on a shared email, a shared phone, or the same name.
-- A shared phone is usually one person typed twice, and just as often a family: a
-- husband and wife with different emails and one number, a child with no email of
-- their own whose parent's was used. Merging those would lose a client, and the list
-- had no way to say no, so the same pairs came back every time somebody opened the
-- page and the list stopped being worth reading.
--
-- One row per pair somebody has looked at and decided are two people. Normalised so
-- a_id sorts before b_id, which is how the list orders every pair, so the lookup is
-- one comparison and a pair is stored once however it was reached. The decision is
-- the advisor's, so the row belongs to them; it says nothing about the records
-- beyond that, and either one can still be merged with somebody else.
CREATE TABLE IF NOT EXISTS client_not_duplicates (
  user_id    TEXT NOT NULL,
  a_id       TEXT NOT NULL,
  b_id       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id)
);

CREATE INDEX IF NOT EXISTS idx_not_dupes_user ON client_not_duplicates (user_id);
