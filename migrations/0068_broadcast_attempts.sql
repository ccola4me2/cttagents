-- How many times we have tried this one.
--
-- The first version of the sender recorded any throw as a failure, which is
-- wrong for exactly the failure it will hit most: Resend rate limits at two
-- requests a second, and a burst of forty arrives faster than that. A 429 is
-- "come back in a moment" and was being written down as "this address does not
-- work", permanently, with no retry.
--
-- So a transient failure now leaves the row queued and the next pass picks it
-- up. That needs a counter, or a Resend outage turns into a row retried
-- forever on every tick for the rest of the year.

ALTER TABLE broadcast_recipients ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
