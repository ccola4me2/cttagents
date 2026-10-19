-- Corporate targets: what the whole agency sets out to do in a year. An owner's to see and set, one row per
-- agency and year. The advisor's own targets stay in goals; these are the agency's.
--
--   basis           purchase (counted when reservations are taken) or departure (when people travel)
--   count_personal  whether advisors' own travel counts towards the agency's figures
--   agency_goal_cents  what the agency itself keeps after its advisors' shares
CREATE TABLE IF NOT EXISTS agency_goals (
  agency_id             TEXT NOT NULL,
  year                  INTEGER NOT NULL,
  sales_goal_cents      INTEGER NOT NULL DEFAULT 0,
  commission_goal_cents INTEGER NOT NULL DEFAULT 0,
  agency_goal_cents     INTEGER NOT NULL DEFAULT 0,
  bookings_goal         INTEGER NOT NULL DEFAULT 0,
  basis                 TEXT NOT NULL DEFAULT 'purchase',
  count_personal        INTEGER NOT NULL DEFAULT 0,
  aim                   TEXT,
  updated_by            TEXT,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (agency_id, year)
);
