-- Who may sell into a group, and on what terms.
--
--   selling              private (only its advisor), open (any advisor in the agency) or request (an
--                        advisor asks and the group's advisor approves)
--   advisor_notes        instructions for other advisors, never shown to clients
--   outside_advisor_pct  the share of commission the booking advisor keeps on a reservation they put into
--                        this group when it is not their own. Empty means their usual agreement. Only an
--                        owner sets it, and it is copied onto each reservation when it is booked.
--   selling_changed_by / selling_changed_at   who last changed the setting, and when
ALTER TABLE travel_groups ADD COLUMN selling TEXT NOT NULL DEFAULT 'private';
ALTER TABLE travel_groups ADD COLUMN advisor_notes TEXT;
ALTER TABLE travel_groups ADD COLUMN outside_advisor_pct REAL;
ALTER TABLE travel_groups ADD COLUMN selling_changed_by TEXT;
ALTER TABLE travel_groups ADD COLUMN selling_changed_at INTEGER;

-- An advisor's request to sell into a group that takes requests, and the answer.
CREATE TABLE IF NOT EXISTS group_access (
  id         TEXT PRIMARY KEY,
  agency_id  TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_access_one ON group_access (group_id, user_id);
CREATE INDEX IF NOT EXISTS idx_group_access_agency ON group_access (agency_id, status);
