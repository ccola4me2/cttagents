-- Several reservations, one trip.
--
-- Samantha's Spain holiday is nine reservations: the flights, three hotels, a
-- train and four tours. To her client it is one trip, and to the portal it has
-- been nine rows with nothing joining them. The client page answers one
-- reservation at a time, and the client-level page guessed at holidays from
-- dates that happened to touch. A person who knows what belongs together ought
-- to be able to say so.
--
-- A trip is a name, a welcome, some things worth knowing, and a link. The
-- reservations stay exactly what they were, with their own money, their own
-- documents and their own page; each one just points at the trip it belongs to.
-- A reservation is in at most one trip, which is what a holiday is.
--
-- share_code is for the client's link, served at /i/<code>. A partial unique
-- index, as on clients.hub_code: most trips will never be shared, NULL is not
-- equal to NULL, and a plain unique index would say something it does not mean.
CREATE TABLE IF NOT EXISTS trips (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  client_id   TEXT,
  name        TEXT NOT NULL,
  intro       TEXT,
  tips        TEXT,
  share_code  TEXT,
  shared_at   INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_share ON trips (share_code) WHERE share_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trips_user ON trips (user_id);

ALTER TABLE bookings ADD COLUMN trip_id TEXT;
CREATE INDEX IF NOT EXISTS idx_bookings_trip ON bookings (trip_id) WHERE trip_id IS NOT NULL;
