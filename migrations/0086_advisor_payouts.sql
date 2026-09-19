-- What the agency actually paid the advisor.
--
-- The portal could say what a vendor owed, what the vendor had paid, and what
-- the advisor was owed out of it. It had nothing at all for the last step:
-- the agency writing the cheque. So the payout run was a list that looked
-- identical on the 15th and the 30th, and the only record that somebody had
-- been paid lived in a bank statement and somebody's memory.
--
-- Two tables, the same shape as the vendor half above it, and for the same
-- reason. One payment covers many reservations, and what makes it a record
-- rather than a number is knowing which. Without the lines there is no way to
-- say what is still owed on a trip whose base commission was paid out in
-- March and whose bonus arrived in June.
CREATE TABLE IF NOT EXISTS advisor_payouts (
  id           TEXT PRIMARY KEY,
  -- The advisor being paid. This is the fence: an advisor reads their own
  -- payouts and nobody else's, the same as every other table here.
  user_id      TEXT NOT NULL,
  paid_on      TEXT,                -- ISO day
  amount_cents INTEGER NOT NULL DEFAULT 0,
  method       TEXT,                -- check | ach | cash | other
  reference    TEXT,                -- cheque number, transfer reference
  notes        TEXT,
  -- Who recorded it, which is never the advisor. An advisor who could write
  -- one could declare themselves paid; the endpoint refuses them and this
  -- column says which owner did it.
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payout_user ON advisor_payouts (user_id, paid_on);

CREATE TABLE IF NOT EXISTS advisor_payout_lines (
  id           TEXT PRIMARY KEY,
  payout_id    TEXT NOT NULL,
  booking_id   TEXT NOT NULL,
  -- The advisor again, carried down so a line is reachable by the same fence
  -- as everything else rather than only through its parent.
  user_id      TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (payout_id) REFERENCES advisor_payouts (id) ON DELETE CASCADE,
  FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payout_line_booking ON advisor_payout_lines (booking_id);
CREATE INDEX IF NOT EXISTS idx_payout_line_payout ON advisor_payout_lines (payout_id);
