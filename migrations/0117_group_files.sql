-- PDFs a group's page offers for download: the flyer, the itinerary, the brochure.
--
-- The file is in the private bucket and the page links to it through the Worker, at /gf/<id>, only
-- while the group's page is on. This is the row that says what it is called on the page and where
-- the file is kept.
CREATE TABLE IF NOT EXISTS group_files (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  filename    TEXT NOT NULL,
  object_key  TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_files_group ON group_files (group_id, user_id);
