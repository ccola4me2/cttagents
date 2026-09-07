-- Knowing the invoice the client is holding is out of date.
--
-- Sending an invoice already worked. What did not exist was any sense that it
-- had gone stale: a payment gets posted, an amenity is added, a price changes,
-- and the document in the client's inbox quietly stops matching the booking.
-- Nothing on the screen says so, so the advisor either resends after every
-- edit out of caution or, far more often, never resends at all.
--
-- A fingerprint of exactly what was sent, taken at the moment of sending. The
-- reservation compares the current statement against it and can then say
-- "changed since you sent it", which is a smaller and much more useful claim
-- than "something might have changed".

ALTER TABLE bookings ADD COLUMN statement_hash TEXT;
