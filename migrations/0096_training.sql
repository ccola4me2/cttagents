-- Teaching somebody the portal, rather than sitting beside them.
--
-- Every advisor so far learned this by having Brent explain it, which works
-- and does not scale: the same eight questions get answered out loud every
-- time somebody joins, and whoever joined last week is the only person who
-- knows which parts they never got told.
--
-- The manual already says how everything works. What it cannot do is say what
-- to learn first, or record that somebody got there. A new advisor opening a
-- five hundred line page does not know whether to start at the top, and the
-- owner has no way to tell the difference between "read it all" and "opened
-- it once".
--
-- So: a course over the manual, in the order a first week actually happens,
-- and one row per lesson somebody finishes. Deliberately not a score and not a
-- test. Nobody is being marked. It is a checklist that survives being closed,
-- so an advisor can stop half way and an owner can see where everybody is.
--
-- The lessons themselves live in src/training.js rather than in here. They
-- change with the portal, and content in a migration is content that can only
-- be corrected by writing another migration.
--
-- UNIQUE on (user_id, lesson) because finishing a lesson twice is finishing it
-- once. That makes the write an upsert rather than a read followed by an
-- insert, which is the version that races when somebody double taps.
CREATE TABLE IF NOT EXISTS training_progress (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  lesson       TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  UNIQUE (user_id, lesson)
);

CREATE INDEX IF NOT EXISTS idx_training_user ON training_progress(user_id);
