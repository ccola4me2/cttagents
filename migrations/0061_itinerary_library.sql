-- Write it once, drop it into any trip.
--
-- Numbered 0056 with 0055 skipped on purpose. The CTT fork already carries its
-- own 0055 for a different change, and two files sharing that number would
-- collide on every cherry-pick between the two from here on.
--
-- The itinerary builder works and is a retyping exercise. The same advisor
-- describes the same Palancar Reef snorkelling every time they sell it, in
-- slightly different words, with the meeting time wrong on one of them. That
-- is where a tool like this gets abandoned: not because it cannot do the job,
-- because doing the job twice is slower than the email it replaced.
--
-- A saved piece is not a template for a whole trip. It is one line: an
-- excursion, a hotel, a transfer, a note about what to pack for Alaska. Trips
-- are assembled from them, and a piece dropped onto a trip is copied rather
-- than linked, so editing the saved wording afterwards cannot rewrite what a
-- client was already shown.
--
-- Shared across the agency, like the supplier directory and for the same
-- reason: the description of a shore excursion is the agency's knowledge of
-- that excursion, not one person's note. The advisor who wrote it is recorded
-- so it is clear who to ask, and anybody may correct it.

CREATE TABLE IF NOT EXISTS itinerary_library (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  -- What it is called in the picker, which is not what the client reads.
  -- "Cozumel: Palancar Reef" finds it; the title is what goes on the trip.
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'activity',
  title        TEXT NOT NULL,
  location     TEXT,
  detail       TEXT,
  image_url    TEXT,
  -- Roughly when it happens, carried across so a piece dropped on a day lands
  -- at the right time rather than at the top.
  start_time   TEXT,
  end_time     TEXT,
  -- How often it has been used, so the ones an advisor actually reaches for
  -- rise to the top of a list of two hundred.
  used_count   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_itin_library_user ON itinerary_library (user_id, name);
