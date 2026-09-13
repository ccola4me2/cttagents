-- A list of people, described by what they have booked rather than listed out.
--
-- Saved as rules and resolved when it is used, not as a set of client ids. A
-- list called "sailing in the next sixty days" has to mean that in November as
-- well as September, and a stored membership would have to be rebuilt by
-- something, on a schedule, and would be wrong in between.
--
-- Per advisor. Two people will both make a list called "Alaska" and mean
-- different things by it, and a shared namespace turns that into an argument.

CREATE TABLE IF NOT EXISTS segments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  -- The rules as the page sent them, resolved at read time.
  rules_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_segments_user ON segments (user_id, name);
