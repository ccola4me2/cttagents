-- People a client travels with who do not live with them.
--
-- A household is the people at one address. A companion is the sister two
-- states away, the friend they cruise with every year, the neighbour who comes
-- along: somebody who turns up as the second name on a booking and is not in
-- the house. Linking them lets the reservation offer them as travellers with
-- their passports already filled in, the way it does for a household.
--
-- One row each way, so "who does this client travel with" is a single lookup
-- and neither direction has to be searched for. relation is the label the
-- advisor chose (companion, friend, family, colleague, other) and is the same
-- both ways round. Both clients belong to the one advisor: the link never
-- crosses from one advisor's book to another's.
CREATE TABLE IF NOT EXISTS client_companions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  relation     TEXT NOT NULL DEFAULT 'companion',
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_companions_pair
  ON client_companions (client_id, companion_id);
CREATE INDEX IF NOT EXISTS idx_client_companions_user ON client_companions (user_id, companion_id);
