-- Telling advisors about an agency event, and choosing who is invited.
--
--   announced_at  when an owner last emailed the advisors about it, empty if never
--   remind        whether advisors who have not said they are going get a note the day before (on unless an owner says not)
--   reminded_at   when that note went, so it is never sent twice
--   audience      all: every advisor in the agency. some: only those listed in agency_event_invites. An owner sees every event
--                 whoever it is for; an advisor sees the ones they are invited to.
ALTER TABLE agency_events ADD COLUMN announced_at INTEGER;
ALTER TABLE agency_events ADD COLUMN remind INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agency_events ADD COLUMN reminded_at INTEGER;
ALTER TABLE agency_events ADD COLUMN audience TEXT NOT NULL DEFAULT 'all';

CREATE TABLE IF NOT EXISTS agency_event_invites (
  event_id   TEXT NOT NULL,
  agency_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_agency_event_invites_user ON agency_event_invites (agency_id, user_id);
