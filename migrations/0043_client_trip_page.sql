-- A page the client can open.
--
-- Everything this portal knows about a trip stops at the advisor's screen.
-- The client gets a PDF in an email and, three weeks later, asks what they
-- have paid and when the balance is due, because the answer lives in an inbox
-- rather than anywhere they can look.
--
-- The code is the address and it is not the booking id: a page anybody can
-- reach by counting is not a page, and the id is used in URLs the advisor
-- shares over their shoulder. Sharing is off until it is turned on, per trip.
--
-- Documents are opted in one at a time and default to off. This matters more
-- than it looks: the agent confirmation the importer reads carries the
-- commission on it, and a trip page that helpfully offered every file would
-- publish exactly the number the client must never see.

ALTER TABLE bookings ADD COLUMN share_code TEXT;
ALTER TABLE bookings ADD COLUMN shared_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_share ON bookings (share_code)
  WHERE share_code IS NOT NULL;

ALTER TABLE documents ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;

-- What the client said back, since the page is read only and the whole point
-- is that they tell the advisor rather than change anything themselves.
CREATE TABLE IF NOT EXISTS trip_messages (
  id         TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  body       TEXT NOT NULL,
  ip_hash    TEXT,
  read_at    INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trip_messages ON trip_messages (booking_id, created_at);
