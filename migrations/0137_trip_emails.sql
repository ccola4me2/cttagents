-- The emails a client gets on their own after a reservation is made.
--
--   trip_emails          one row per email per reservation: which, the day it goes, and where it stands. The
--                        unique pair (booking_id, kind) is what lets the planner run every few minutes and never
--                        plan the same email twice.
--   trip_email_wording   the agency's own words for an email, one row per agency and kind. A kind with no row
--                        uses the built-in wording.
--   agencies.trip_emails_since   when an owner switched the automatic emails on. Empty means off. Only
--                        reservations made after this moment are planned, so nobody's existing clients are
--                        written to the day it is switched on.
--   bookings.emails_off  an advisor's switch for one reservation: none of its automatic emails go.
CREATE TABLE IF NOT EXISTS trip_emails (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  due_on      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled',
  sent_at     INTEGER,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trip_emails_booking_kind ON trip_emails (booking_id, kind);
CREATE INDEX IF NOT EXISTS idx_trip_emails_due ON trip_emails (status, due_on);

CREATE TABLE IF NOT EXISTS trip_email_wording (
  agency_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  subject     TEXT,
  body        TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (agency_id, kind)
);

ALTER TABLE agencies ADD COLUMN trip_emails_since INTEGER;
ALTER TABLE bookings ADD COLUMN emails_off INTEGER NOT NULL DEFAULT 0;
