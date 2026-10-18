-- Who looked at a group's page, so the owner can see visits and what came of them.
--
-- One row per group, day, visitor and page. A visitor is a hash of the address and browser on that
-- day for that group, so nothing that identifies a person is kept and the same person tomorrow is a
-- new visitor. views counts how often that visitor opened the page that day.
--
--   kind  'page' is the group's page; 'register' is its sign-up page
CREATE TABLE IF NOT EXISTS group_visits (
  group_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  day        TEXT NOT NULL,
  visitor    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  views      INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, day, visitor, kind)
);

CREATE INDEX IF NOT EXISTS idx_group_visits_owner ON group_visits (user_id, day);
