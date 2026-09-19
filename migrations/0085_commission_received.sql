-- Commission has two states now, not four.
--
-- pending | invoiced | paid became pending | received. What an owner asks
-- twice a month, before a payout run, is whether the vendor has actually
-- paid, and that question has two answers. "Invoiced" answered a different
-- one, about paperwork, and went stale the day it was set.
--
-- paid becomes received: the money is in, which is what paid meant.
--
-- invoiced becomes pending, not received. It meant the claim had gone out and
-- nothing had come back, which is what pending means. Folding it into
-- received would mark every one of those trips as settled on the strength of
-- an invoice nobody has been paid against, and the money would be written off
-- in a report rather than chased.
--
-- updated_at is deliberately left alone. This renames a value; it does not
-- edit a reservation, and stamping every row today would make the whole book
-- read as changed this morning and push it to the top of every recent list.
UPDATE bookings SET commission_status = 'received' WHERE commission_status = 'paid';
UPDATE bookings SET commission_status = 'pending' WHERE commission_status = 'invoiced';
