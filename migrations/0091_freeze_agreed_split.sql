-- Freeze the book at the agreement as it stands today.
--
-- 0074 stamped the agreement onto every reservation so that changing a rate
-- would stop restating money already earned. It ran when no advisor had a rate
-- recorded, and it deliberately copied nulls as nulls: "no agreement recorded"
-- is not an agreement that the advisor keeps everything, and freezing a null
-- as 100 would have meant an advisor who sold before their agreement was
-- written down keeps the lot on those trips for ever, silently.
--
-- So it stamped nothing, and 20 of the 21 reservations were left following
-- whatever the advisor's record said at the moment somebody opened a report.
-- That was the right place for them to be while there was nothing to read.
--
-- The rates were recorded today, and the whole book picked them up at once,
-- which is what was wanted: the agency's share went from $0.00 to a real
-- figure on trips going back to the start. Now that there is something to
-- freeze, freeze it, because the next rate change would move these same trips
-- again, including ones already invoiced and already paid out.
--
-- Only where nothing is stamped. A row that already carries an agreement
-- carries it because it was taken under that agreement, and a deliberate 0,
-- which is a house account, is not a null and is not touched. The two columns
-- are considered separately: a reservation may have one rate stamped and not
-- the other, and filling the gap is not the same as overwriting the answer.
--
-- Where an advisor still has no rate on their record the subquery yields null
-- and the row stays as it is, which is the same judgement 0074 made and for
-- the same reason.
--
-- This moves no figure anywhere. It writes down what every one of these trips
-- already reads as today, which is why it is safe to run and why running it
-- changes nothing on any screen. What it changes is the future: from here a
-- rate change reaches new work only.

UPDATE bookings
   SET agreed_split_pct =
         (SELECT u.default_split_pct FROM users u WHERE u.id = bookings.user_id)
 WHERE agreed_split_pct IS NULL;

UPDATE bookings
   SET agreed_lead_split_pct =
         (SELECT u.lead_split_pct FROM users u WHERE u.id = bookings.user_id)
 WHERE agreed_lead_split_pct IS NULL;
