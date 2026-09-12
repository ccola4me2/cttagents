-- The trip, day by day.
--
-- A reservation knows what was sold: the supplier, the ship, the dates, what
-- it cost. It has never known what actually happens on the trip, so the day
-- the client asks "what time do we dock in Cozumel and is the snorkelling
-- booked" the answer lives in an email thread, and the page they were given
-- is a receipt rather than an itinerary.
--
-- An item hangs off a day number rather than a date. Day 1 is departure, and
-- a trip that moves by a week moves with it: dates are worked out at read
-- time from the reservation's own departure. Written as a date instead, every
-- item would need rewriting the moment a sailing shifted, which is exactly
-- when nobody has time to do it.
--
-- Times are optional and text. Half of what happens on a trip has a time on
-- the ticket and half is "morning, before it gets hot", and forcing the second
-- into a time field produces a schedule nobody believes.

CREATE TABLE IF NOT EXISTS itinerary_items (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  -- 1-based. NULL means it belongs to the trip rather than to a day: the
  -- travel insurance policy number, the emergency contact, what to pack.
  day_number   INTEGER,
  -- HH:MM, or empty for "some time that day". Sorted before the free ones.
  start_time   TEXT,
  end_time     TEXT,
  -- flight, cruise, hotel, transfer, activity, meal, free, note.
  kind         TEXT NOT NULL DEFAULT 'activity',
  title        TEXT NOT NULL,
  location     TEXT,
  detail       TEXT,
  -- The vendor's own reference for this piece, which is the thing a client is
  -- asked for at a desk and cannot find.
  confirmation TEXT,
  -- A picture of the place. A URL rather than an upload: it is nearly always
  -- already on the supplier's site, and a second copy is a second thing to
  -- keep current.
  image_url    TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_itinerary_booking
  ON itinerary_items (booking_id, day_number, sort_order);
CREATE INDEX IF NOT EXISTS idx_itinerary_user ON itinerary_items (user_id);

-- Whether the client's page shows the itinerary at all. Off until there is
-- something worth showing, so a trip with three half-written days does not
-- publish itself the moment the first line is typed.
ALTER TABLE bookings ADD COLUMN itinerary_shared INTEGER NOT NULL DEFAULT 0;
