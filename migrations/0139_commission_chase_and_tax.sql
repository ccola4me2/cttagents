-- Two things the commission desk needed.
--
-- 1. A reservation's commission that the vendor has not paid can be marked Disputed (the vendor has been asked and the
--    answer is awaited) or Written off (it will not be collected). Neither changes what was expected or what arrived: a
--    written off amount simply stops counting as owed, and a disputed one is set apart so it is not chased as routine.
--      commission_chase       null, 'disputed' or 'written_off'
--      commission_chase_note  why, in a sentence
--      commission_chase_at    when it was marked
ALTER TABLE bookings ADD COLUMN commission_chase TEXT;
ALTER TABLE bookings ADD COLUMN commission_chase_note TEXT;
ALTER TABLE bookings ADD COLUMN commission_chase_at INTEGER;

-- 2. What the agency needs on file to report what it paid an advisor at year end (a 1099-NEC): the name and kind of
--    taxpayer, the last four digits of the tax number (never the whole number, which belongs in the W-9 itself), the
--    mailing address, and when the W-9 arrived. Owners enter and read it; advisors do not see each other's.
CREATE TABLE IF NOT EXISTS advisor_tax (
  user_id            TEXT PRIMARY KEY,
  legal_name         TEXT,
  business_name      TEXT,
  classification     TEXT,
  tin_type           TEXT,
  tin_last4          TEXT,
  address            TEXT,
  w9_on              TEXT,
  backup_withholding INTEGER NOT NULL DEFAULT 0,
  foreign_payee      INTEGER NOT NULL DEFAULT 0,
  notes              TEXT,
  updated_by         TEXT,
  updated_at         INTEGER NOT NULL
);
