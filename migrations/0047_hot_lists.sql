-- Who to call this week, and a way to say you already did.
--
-- Two dates on the client, because a birthday and an anniversary are reasons
-- to make contact that cost nothing and are welcome, and nowhere in the portal
-- held either one. A traveller's date of birth was already collected for the
-- passport, so the birthday list has something to show on day one; these
-- columns are for the client whose birthday you know without ever having put
-- them on a reservation, and for the couple whose anniversary is the whole
-- reason they are going.
--
-- The second table is the half that decides whether any of this gets used. A
-- list that shows the same eight names every week until something changes is
-- a list people stop opening. Ticking a name off writes a row here with a date
-- it comes back, so the list is what is left to do rather than everything that
-- was ever true.

ALTER TABLE clients ADD COLUMN birthday TEXT;
ALTER TABLE clients ADD COLUMN anniversary TEXT;

CREATE TABLE IF NOT EXISTS hotlist_actions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  -- Which list it was ticked off, so calling somebody about their birthday
  -- does not also clear them off the list of clients who have gone quiet.
  list_key   TEXT NOT NULL,
  -- The client, or the credit. Whatever the row was about.
  subject_id TEXT NOT NULL,
  -- The day it comes back. Every list sets its own: a quarter after a
  -- rebooking call, a month after a chase on an expiring credit.
  until_date TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hotlist_action
  ON hotlist_actions (user_id, list_key, subject_id);
CREATE INDEX IF NOT EXISTS idx_hotlist_until
  ON hotlist_actions (user_id, until_date);
