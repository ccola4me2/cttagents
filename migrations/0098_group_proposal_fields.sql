-- What the proposal said, as fields rather than as a paragraph.
--
-- 0096 read a vendor's group proposal and filled in the eight fields a group
-- already had. Everything else it understood went into notes as prose: the
-- proposal number, the sailing, who at the vendor to ring, the port, the
-- passenger count, the date the terms expire, and the rate grid.
--
-- Prose is where facts go to stop being facts. Nothing can search it, nothing
-- can total it, nothing can warn that a proposal expires on Tuesday, and an
-- advisor correcting a rate edits a sentence rather than a number. The parser
-- had the values as values and threw that away on the last step.
--
-- So the flat ones become columns. Text rather than integers for the two ids
-- because they are references printed on paperwork rather than numbers
-- anybody adds up, and a vendor who starts writing 04589 should not have the
-- leading nought quietly removed.
ALTER TABLE travel_groups ADD COLUMN proposal_id TEXT;
ALTER TABLE travel_groups ADD COLUMN sailing_id TEXT;
ALTER TABLE travel_groups ADD COLUMN vendor_contact TEXT;
ALTER TABLE travel_groups ADD COLUMN departure_port TEXT;
ALTER TABLE travel_groups ADD COLUMN passengers INTEGER;
ALTER TABLE travel_groups ADD COLUMN proposal_expires TEXT;

-- And the rate grid becomes rows, because it is one.
--
-- Four grades on this proposal, a different four on the next, and a column per
-- grade would be a table pretending not to be one. Cents, like every other
-- amount in this portal, so nothing is ever a float.
--
-- user_id alongside group_id because that is the fence everything else here is
-- read behind, and a table carrying a user_id that no statement names is the
-- thing scripts/check-scope.mjs exists to refuse.
CREATE TABLE IF NOT EXISTS group_rates (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  room_type       TEXT NOT NULL,
  occupancy       TEXT,
  cabins          INTEGER NOT NULL DEFAULT 0,
  guests          INTEGER NOT NULL DEFAULT 0,
  per_guest_cents INTEGER NOT NULL DEFAULT 0,
  taxes_cents     INTEGER NOT NULL DEFAULT 0,
  total_cents     INTEGER NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_rates_group ON group_rates(group_id);
