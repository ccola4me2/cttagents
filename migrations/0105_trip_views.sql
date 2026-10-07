-- Who opened a client's trip page, and when.
--
-- bookings already carries a count and a first and last time, which answers "was it
-- opened" and nothing else. This is the list behind that count, one row for each
-- visit that was a person, so the reservation can say "opened from the invoice
-- on Tuesday at 3:12 PM" rather than only "opened 3 times".
--
-- source says which link the client followed: invoice, quote, reply, or link for
-- anything without a marker. Automatic link checkers and the advisor's own
-- visits are not recorded, so a row here is somebody looking.
CREATE TABLE IF NOT EXISTS trip_views (
  id         TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'link',
  viewed_at  INTEGER NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trip_views ON trip_views (booking_id, viewed_at);
