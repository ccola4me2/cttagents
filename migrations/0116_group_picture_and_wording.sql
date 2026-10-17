-- A picture a group can be uploaded with, and the wording advisors save as their standard.

-- Where an uploaded picture for a group's page is kept in the private bucket. The page itself
-- shows it through hero_image_url, which is set to the portal's own address for the picture when
-- one is uploaded; this is the key the picture is read from and removed by.
ALTER TABLE travel_groups ADD COLUMN hero_image_key TEXT;

-- The opening and closing words of a quote or an invoice, saved so they are not retyped on
-- every one. A row is one advisor's own wording for one kind (user_id set) or the agency's
-- standard for one kind (user_id empty). An advisor's own wins over the agency's, and either
-- wins over the wording built into the portal.
--
--   intro  the opening message; empty means the portal's own words
--   note   the closing note; empty text means none at the end, and null means not set
CREATE TABLE IF NOT EXISTS statement_wording (
  id         TEXT PRIMARY KEY,
  agency_id  TEXT NOT NULL,
  user_id    TEXT,
  kind       TEXT NOT NULL,
  intro      TEXT,
  note       TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_statement_wording_agency ON statement_wording (agency_id, kind);
