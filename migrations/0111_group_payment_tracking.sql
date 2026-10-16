-- Where a group's money will be tracked, when Phase 2 tracks it.
--
-- Schema only. Nothing reads these yet and no screen offers them, which is
-- deliberate: the shape is worth settling now, while the registration work is
-- fresh, and the UI is a separate piece of work.
--
-- Extending booking_payments rather than adding a payment_tracking table,
-- because booking_payments already is that table. It holds the amount, the due
-- date, the paid date, the method, the reference and whether a line is the
-- vendor's real deadline or the advisor's own reminder in front of it. A
-- second table carrying the same facts would be two sources of truth for the
-- one thing the agency cannot afford to be wrong about.

-- Which sign-up this money came from.
--
-- A party registers, the registration becomes a reservation, and the
-- reservation grows a payment schedule. Without this, the schedule knows
-- nothing about where the party came from, so "who on the group has paid their
-- deposit" has to be answered by matching names.
ALTER TABLE booking_payments ADD COLUMN registration_id TEXT;

-- Who is actually owed this.
--
-- The whole of the money model here in one column. The trip cost is owed to
-- the travel supplier and reaches them through the agency; the agency's own
-- fee is owed to the agency and is a separate transaction with separate refund
-- terms, which is why the registration page shows it as its own line. A
-- schedule that cannot tell the two apart cannot answer "what do we actually
-- hold", and it is the same question a refund turns on.
--
-- NULL on every existing row, and read as 'supplier' by anything that has to
-- decide, because that is what every payment in this portal has meant until
-- now: the client pays the supplier and the portal records it.
ALTER TABLE booking_payments ADD COLUMN owed_to TEXT;

CREATE INDEX IF NOT EXISTS idx_pay_registration
  ON booking_payments (registration_id);

-- Not done here, and worth writing down rather than discovering later:
-- booking_payments.booking_id is NOT NULL and has been since 0005. A payment
-- therefore cannot exist before there is a reservation, so money owed against
-- a bare registration has nowhere to go until it is booked. Changing that
-- means rebuilding the table, which is not something to do to the payment
-- schedule as a side effect of a group feature. Phase 2 decides whether it is
-- worth it.
