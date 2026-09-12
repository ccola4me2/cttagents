-- Did they open it?
--
-- The portal records that a quote was sent and how many times, and then stops.
-- Whether anybody read it is the next question an advisor asks and the portal
-- had no answer, so the honest version of "did you get my email" is still a
-- phone call.
--
-- Three columns rather than one. The count says how interested they are, the
-- first open says how long they sat on it, and the last says whether it is
-- still being looked at. A single timestamp answers none of those on its own.

ALTER TABLE bookings ADD COLUMN viewed_first_at INTEGER;
ALTER TABLE bookings ADD COLUMN viewed_last_at INTEGER;
ALTER TABLE bookings ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
