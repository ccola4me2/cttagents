-- The travel insurance waiver: one per reservation, signed by the client at /w/<code>. The link is the
-- credential. What the client agreed to is copied onto the row as it was worded that day, so a later edit to
-- the words never changes what somebody signed.
--
--   code            the address of the public page
--   sent_at         when the advisor last emailed it, and sent_count how many times
--   view_count      people who opened it; mail scanners and the advisor's own look are not counted
--   signed_at       set once, by the client; a signed row is a record and is never replaced
--   signer_name / signer_email   what the client typed
--   ip_hash         a salted hash of the address it was signed from, never the address
--   wording_version / wording_text   the words in front of them
CREATE TABLE IF NOT EXISTS insurance_waivers (
  id              TEXT PRIMARY KEY,
  booking_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  code            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  sent_count      INTEGER NOT NULL DEFAULT 0,
  view_count      INTEGER NOT NULL DEFAULT 0,
  first_viewed_at INTEGER,
  signed_at       INTEGER,
  signer_name     TEXT,
  signer_email    TEXT,
  ip_hash         TEXT,
  wording_version TEXT,
  wording_text    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_insurance_waivers_code ON insurance_waivers (code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_insurance_waivers_booking ON insurance_waivers (booking_id);
