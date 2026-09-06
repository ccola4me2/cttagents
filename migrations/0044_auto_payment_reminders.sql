-- Reminding the client before the money is due, without being asked to.
--
-- The reminder itself already existed and was a button: the advisor opened the
-- payment and pressed send. That works exactly as well as the advisor's memory,
-- which is the thing the portal is supposed to be replacing.
--
-- Which lead time has gone out is tracked rather than a plain "sent" flag,
-- because three weeks out and one day out are different messages about the same
-- payment and both should arrive. The column holds the smallest lead already
-- sent, so the pass sends only when it has moved closer than that.
--
-- Off until the advisor turns it on. Email that goes to somebody else's clients
-- under somebody else's name is not a default anybody should inherit.

ALTER TABLE booking_payments ADD COLUMN auto_lead_sent INTEGER;
ALTER TABLE users ADD COLUMN auto_remind_clients INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_payments_due_auto
  ON booking_payments (due_date, paid_date);
