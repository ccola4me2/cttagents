-- A quote can be said yes to.
--
-- Declining shipped without its other half. A client could say no to the
-- options on a quote, and could pick one of them if any had been offered, but
-- a quote with a single price on it, which is most of them, had no answer at
-- all: no yes, no no, nothing but replying to the email.
--
-- Choosing an option is already a yes and needs no column, because the option
-- says what was agreed. This is for the quote that offers one price, where the
-- yes is to the whole thing and there is nothing else to point at.
--
-- Deliberately not a status. Accepting is the client's act and booking is the
-- advisor's: the vendor still has to be rung, the space still has to be there,
-- and a trip that moved itself to booked because somebody pressed a button on
-- a web page would put money into production that nobody has taken. This
-- records the answer and leaves the booking to the person who can make it.

ALTER TABLE bookings ADD COLUMN accepted_at INTEGER;
