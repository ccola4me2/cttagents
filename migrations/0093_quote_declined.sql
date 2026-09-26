-- The client can say no.
--
-- A quote could be answered one way only. The trip page offered "Choose this
-- one" against each option and nothing at all against the set of them, so a
-- client who had decided against the whole thing had no way to say so except
-- by replying to an email, and most people do not: they simply stop opening
-- it. The proposal then sat in "Opened, no answer" for ever, which is the
-- advisor's follow-up list, and the follow-up list quietly filled with people
-- who had already decided.
--
-- Two columns rather than a status. Cancelled already means something on a
-- reservation: a booked trip called off, with a deposit taken, a penalty owed
-- and commission that may still be due. A quote nobody accepted is none of
-- that, and folding the two together would put trips that cost money and
-- trips that never existed in the same bucket.
--
-- The reason is optional and theirs, not a list to pick from. "Too much" and
-- "the dates moved" lead to completely different next moves, and an advisor
-- who knows which one it was still has a client.

ALTER TABLE bookings ADD COLUMN declined_at INTEGER;
ALTER TABLE bookings ADD COLUMN declined_reason TEXT;
