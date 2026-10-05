-- A commission check, and the day each part of it is paid out.
--
-- Until now money from a vendor was filed one reservation at a time, with nothing
-- to say it had arrived together on one check, what that check cost, or when the
-- advisor who earned it would be paid. This adds the three.
--
-- commission_checks is the check: who sent it, its number, the day it arrived, what
-- the vendor's page says they paid, and anything taken out before it reached the
-- bank. The fee is the agency's. The advisor's share is worked out from the
-- statement amount, so a processing charge on a check never comes out of an
-- advisor, and it is kept here so it can be counted as the expense it is.
--
-- Each commission_receipts row is one line of that check, against one reservation.
-- check_id says which check it came on; payout_on says which pay date it goes out
-- with. NULL on both is a receipt from before this existed: it belongs to no check
-- and is payable now, which is what it always was.
--
-- The check belongs to the agency and not to an advisor, because one check pays
-- several advisors' reservations. agency_id is the fence; added_by is who recorded
-- it and decides nothing about who may see it. Only owners write one.
CREATE TABLE IF NOT EXISTS commission_checks (
  id              TEXT PRIMARY KEY,
  agency_id       TEXT NOT NULL,
  added_by        TEXT,
  vendor_id       TEXT,
  vendor_name     TEXT NOT NULL,
  -- The check number, or the vendor's own reference for an electronic payment.
  reference       TEXT,
  received_on     TEXT,
  -- The date printed on the vendor's remittance, which is not the day it arrived.
  remitted_on     TEXT,
  -- What the vendor says they paid for, before anything was taken out.
  statement_cents INTEGER NOT NULL DEFAULT 0,
  -- Taken out of it on the way, and why. Never charged to an advisor.
  fee_cents       INTEGER NOT NULL DEFAULT 0,
  fee_note        TEXT,
  notes           TEXT,
  filename        TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commission_checks_agency ON commission_checks (agency_id, received_on);

ALTER TABLE commission_receipts ADD COLUMN check_id TEXT;
ALTER TABLE commission_receipts ADD COLUMN payout_on TEXT;

CREATE INDEX IF NOT EXISTS idx_comm_rcpt_check ON commission_receipts (check_id);
CREATE INDEX IF NOT EXISTS idx_comm_rcpt_payout ON commission_receipts (user_id, payout_on);
