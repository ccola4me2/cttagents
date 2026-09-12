-- Let the client pick, instead of describing their pick in a message.
--
-- Options already existed and the client page already showed them, read only,
-- under "If you would rather have one of the others, tell your advisor below".
-- So the client typed "we'll take the balcony" into a message box and the
-- advisor transcribed it into the record. That is a proposal that stops one
-- step short of the only thing a proposal is for.
--
-- Three additions. A picture and a list of what is included, because a choice
-- between three lines of text and a number is not a choice anybody enjoys
-- making. And a record of who chose and when, because "the client picked this
-- on Tuesday" and "I ticked this while we were on the phone" are different
-- facts and only one of them is evidence.
--
-- Choosing deliberately does not set the price on the reservation. The advisor
-- does that, as they do now. A client tapping a button is a decision to
-- confirm, not money moving, and this portal never moves money on its own.

ALTER TABLE quote_options ADD COLUMN image_url TEXT;
ALTER TABLE quote_options ADD COLUMN inclusions TEXT;
-- Seconds, like everything else with a time on it here.
ALTER TABLE quote_options ADD COLUMN chosen_at INTEGER;
-- 'client' or 'advisor'. Null until somebody chooses.
ALTER TABLE quote_options ADD COLUMN chosen_by TEXT;

-- Whether the client may choose at all. Off by default: a quote still being
-- written should not be answerable, and an advisor who has already taken the
-- decision on the phone does not want the page contradicting them.
ALTER TABLE bookings ADD COLUMN options_open INTEGER NOT NULL DEFAULT 0;
