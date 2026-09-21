-- One page a client can open to see everything we hold for them.
--
-- A reservation has been shareable for a while: share_code on the booking,
-- served at /t/<code>, no login, the link is the credential. It works and it
-- answers one trip. Scott Weidman has eight reservations that are one holiday
-- in Spain, so answering one trip eight times is not the same as answering
-- the question he actually has.
--
-- The same model one level up. A code on the client rather than the booking,
-- served at /c/<code>, listing every trip they have with us. Nothing new to
-- log into, nothing to reset, and the same thing to be careful about: a link
-- that reaches everything is a link worth guarding.
--
-- Partial unique index rather than a plain one. Most clients will never have
-- a code, and NULL is not equal to NULL in SQLite, so a plain unique index
-- would allow duplicates it looks like it forbids; a partial index says what
-- it means and indexes only the rows that have one.
ALTER TABLE clients ADD COLUMN hub_code TEXT;
ALTER TABLE clients ADD COLUMN hub_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_hub
  ON clients (hub_code) WHERE hub_code IS NOT NULL;
