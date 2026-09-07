-- More than one agency on the same portal.
--
-- The data was already fenced: scopeWhere widens an owner's view to everybody
-- sharing their GoHighLevel sub-account, so reservations, clients and money
-- stayed inside one book. The people were not. listUsers had no filter at all,
-- so every owner saw every advisor on the platform, and the advisor handlers
-- took a user id and checked only that the caller was an owner, which let one
-- agency suspend another's staff or change their commission split. None of
-- that mattered with one agency and all of it matters with two.
--
-- The fence also moves. It was the GoHighLevel location id, falling back to a
-- default when an advisor had none, which meant two agencies with no
-- sub-account of their own both landed on that default and their books merged.
-- An agency is now a row, and the fence is which agency you are in.
--
-- Two levels of owner, kept apart because they are different jobs. `role` is
-- unchanged and still means the owner of one agency: every check that reads it
-- means the same thing after this as before. `platform_owner` is the operator
-- of the whole portal, which is a new idea and gets a new column rather than a
-- third value in a field fourteen places already test against.

CREATE TABLE IF NOT EXISTS agencies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- The join link handed to their advisors: /join/<slug>. Its own field rather
  -- than the id because it goes in an email somebody reads.
  slug          TEXT NOT NULL,
  -- Where their CRM lives. Inherited by advisors on signup; no longer what
  -- separates one agency's records from another's.
  ghl_location_id TEXT,
  address       TEXT,
  phone         TEXT,
  email         TEXT,
  website       TEXT,
  seller_of_travel TEXT,
  -- White label. A URL rather than an upload: their logo already lives
  -- somewhere on their own site, and one more copy to keep current is one more
  -- thing to go stale.
  logo_url      TEXT,
  brand_color   TEXT,
  tagline       TEXT,
  -- Whether the join link takes anybody at the moment.
  join_open     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agencies_slug ON agencies (slug);

ALTER TABLE users ADD COLUMN agency_id TEXT;
ALTER TABLE users ADD COLUMN platform_owner INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_agency ON users (agency_id);

-- The agency everybody is already in. Named plainly and renamed on the
-- agencies screen; inventing a better name here would only be a guess written
-- into a migration.
INSERT OR IGNORE INTO agencies (id, name, slug, tagline, join_open, created_at, updated_at)
VALUES ('agency-house', 'Trip Vara', 'trip-vara',
        'From first inquiry to welcome home.', 1,
        strftime('%s','now'), strftime('%s','now'));

UPDATE users SET agency_id = 'agency-house' WHERE agency_id IS NULL;

-- Current owners keep the reach they already have. This grants nothing new:
-- before this migration every owner could see and change every advisor, so
-- anything else would be a quiet demotion in a schema change. Turn them off on
-- the agencies screen.
UPDATE users SET platform_owner = 1 WHERE role = 'admin';
