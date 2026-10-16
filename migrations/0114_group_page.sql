-- A group's page, made to be shared.
--
-- Until now a group's public page lived at /g/<group number> and said what the
-- record said: dates, rates, an FAQ. The group number is the supplier's reference
-- and was never meant to be typed into a text message. This gives the page a short
-- name of its own, kept apart from the supplier's number, and the few things a page
-- people are asked to book on needs and the record did not hold.

-- The short name: cruisegrouppage.com/<page_slug>. Lower case letters, numbers and
-- hyphens. Unique across both portals; the table below is what enforces it here.
ALTER TABLE travel_groups ADD COLUMN page_slug TEXT;
-- One line under the title.
ALTER TABLE travel_groups ADD COLUMN headline TEXT;
-- A picture across the top, as a link to an image the agency already has. Not an
-- upload: the document bucket is private on purpose and this page is public.
ALTER TABLE travel_groups ADD COLUMN hero_image_url TEXT;
-- What the group gets, as a JSON array of short lines.
ALTER TABLE travel_groups ADD COLUMN perks_json TEXT;
-- Day by day, as a JSON array of {day, port, note}.
ALTER TABLE travel_groups ADD COLUMN itinerary_json TEXT;

-- Every short name a group has held, and the ones it still holds.
--
-- A name that is changed is archived, not dropped: the old link is in somebody's
-- text message, and it keeps working and keeps meaning that group. An archived name
-- stays reserved to the advisor, so nobody else can take it and catch people who
-- still hold the old link. The same advisor can move it to a newer group, which
-- marks it released here and leaves it on the old group's history as a name it had.
--
--   current   the name the group is shared under now
--   archived  a name it used to have; still redirects to the group
--   released  a name it had and no longer has; resolves to nothing
CREATE TABLE IF NOT EXISTS group_slugs (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'current',
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- A name belongs to one group at a time, whatever its history. A released name is
-- history and can appear any number of times.
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_slugs_live ON group_slugs (slug)
  WHERE status IN ('current', 'archived');
CREATE INDEX IF NOT EXISTS idx_group_slugs_group ON group_slugs (group_id, user_id);
