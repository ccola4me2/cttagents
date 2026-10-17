-- Things the whole agency does together: a vendor training, a webinar, an office meeting.
--
-- An appointment belongs to one advisor's diary. An agency event belongs to the agency, is made by
-- an owner, and appears on every advisor's calendar and on their dashboard. Advisors can say
-- whether they are going; the owner sees who said so.
--
--   kind       training, webinar, meeting or other
--   vendor     who is giving it, when a supplier is
--   tz         the zone the times are in, as the invitation states it (ET, PT, ...)
--   link       the join link, https only
CREATE TABLE IF NOT EXISTS agency_events (
  id           TEXT PRIMARY KEY,
  agency_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  vendor       TEXT,
  on_date      TEXT NOT NULL,
  start_time   TEXT NOT NULL,
  end_time     TEXT,
  tz           TEXT,
  link         TEXT,
  notes        TEXT,
  cancelled_at INTEGER,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agency_events_day ON agency_events (agency_id, on_date);

-- One advisor's answer to one event. A row means going; no row means no answer yet.
CREATE TABLE IF NOT EXISTS agency_event_going (
  event_id   TEXT NOT NULL,
  agency_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_agency_event_going_agency ON agency_event_going (agency_id, event_id);
