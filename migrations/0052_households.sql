-- People who live at the same address, kept together.
--
-- A client record is one person, which is right: they have their own birthday,
-- their own passport, and their own trips. But most of them do not travel
-- alone, and the portal had no idea that the Gallo on one row and the Gallo on
-- another are married. So the address is typed twice and drifts, a couple
-- looks like two unrelated names in the list, and every reservation for either
-- of them starts by typing the other one's name from memory.
--
-- That last part is the point of this. A household is not a tidier client
-- list; it is knowing who else is likely to be on the booking. Put one of them
-- on a reservation and the rest of the house is offered as travellers, with
-- what is already known about each of them.
--
-- The address lives here rather than on the client, because it is the thing
-- they share and the reason they are a household at all. A client who moves
-- out is moved out of the household, and their trips go with them: the
-- household groups people, it does not own anything.

CREATE TABLE IF NOT EXISTS households (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  -- "The Gallo household". Suggested from the surname they share and editable,
  -- because plenty of houses do not share one.
  name       TEXT NOT NULL,
  address    TEXT,
  -- The landline, or whichever number reaches the house rather than a person.
  phone      TEXT,
  notes      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_households_user ON households (user_id, name);

ALTER TABLE clients ADD COLUMN household_id TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_household ON clients (household_id);
