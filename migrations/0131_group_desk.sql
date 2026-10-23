-- The Group Desk: a private place for a few people who share groups across agencies, served at
-- cruisegrouppage.com/desk.
--
--   agencies.is_desk   the one agency whose members use the desk. Its members are not CTT advisors: they
--                      sign in on the group domain only, and the data fence (agency_id) keeps them apart.
--   user_brand         how one person's pages read when it should not be the agency's: their own name, logo,
--                      colour and contact. Blank fields fall back to the agency's.
--   group_cabins       the sheet behind a group: one row per cabin booking, who booked it, and its status.
ALTER TABLE agencies ADD COLUMN is_desk INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_brand (
  user_id    TEXT PRIMARY KEY,
  name       TEXT,
  tagline    TEXT,
  color      TEXT,
  phone      TEXT,
  email      TEXT,
  website    TEXT,
  logo_key   TEXT,
  updated_at INTEGER NOT NULL
);

-- guests is how many people are in the cabin, which is what tour conductor credits are counted from.
-- status is held, deposit, paid or cancelled; a cancelled cabin stops counting. registration_id points at
-- the sign-up it came from when it came from one. user_id is the group's owner, which is the fence.
CREATE TABLE IF NOT EXISTS group_cabins (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  cabin_no        TEXT,
  category        TEXT,
  guests          INTEGER NOT NULL DEFAULT 0,
  guest_names     TEXT,
  booked_by       TEXT,
  booking_no      TEXT,
  status          TEXT NOT NULL DEFAULT 'held',
  tc              INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  registration_id TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  updated_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_cabins_group ON group_cabins (group_id, sort_order);
