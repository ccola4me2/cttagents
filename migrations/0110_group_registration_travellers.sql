-- Registering for a group trip, rather than putting your name down for one.
--
-- group_registrations already existed and held a name, an email, a phone and
-- "how many of you". That is an enquiry. It cannot say which cabin grade
-- somebody picked, whether anybody has acted on it, or that they saw the terms
-- before they agreed to them.

-- Which rate band. Nullable, because every registration taken before this
-- migration was taken without one, and because an enquiry through the short
-- form still does not involve picking a cabin.
ALTER TABLE group_registrations ADD COLUMN rate_id TEXT;

-- Where it has got to. 'new' for everything that exists today, which is true:
-- nobody has worked any of them, because until now there was nowhere to say so.
ALTER TABLE group_registrations ADD COLUMN status TEXT NOT NULL DEFAULT 'new';

-- When they ticked the box, and what they ticked. The text is copied onto the
-- registration rather than referenced, because the terms on the group can be
-- edited afterwards and the only useful record is what was actually on screen
-- at the moment somebody agreed. A pointer would quietly rewrite history.
ALTER TABLE group_registrations ADD COLUMN terms_at INTEGER;
ALTER TABLE group_registrations ADD COLUMN terms_text TEXT;

-- The supplier's own reference for this party, once there is one.
ALTER TABLE group_registrations ADD COLUMN supplier_ref TEXT;

ALTER TABLE group_registrations ADD COLUMN updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_group_reg_rate ON group_registrations (rate_id);
CREATE INDEX IF NOT EXISTS idx_group_reg_status ON group_registrations (group_id, status);

-- The people actually travelling, as opposed to the person who filled the form
-- in.
--
-- A table of its own rather than more columns on the registration, because a
-- party is one to four people and each of them has their own passport, their
-- own date of birth and their own allergy. The existing `travellers` table
-- hangs off a booking, and a registration is not a booking yet: it becomes one
-- later, or it does not.
--
-- Three columns are encrypted at rest and say so in their names. Date of birth
-- and passport details are the only things this portal holds that are worth
-- stealing on their own, and a group trip page is the one place in it where a
-- stranger on the public internet types them in. See src/pii.js and
-- docs/encryption.md.
--
-- They are TEXT because ciphertext is text, and they cannot be searched,
-- sorted or compared in SQL. That is the cost and it is the point: a column
-- you can still query is a column that is not really encrypted.
CREATE TABLE IF NOT EXISTS group_travellers (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  dob_enc TEXT,
  passport_number_enc TEXT,
  passport_expiry_enc TEXT,
  -- Not encrypted. A country of issue narrows nobody down and is wanted on
  -- every manifest, so encrypting it would cost the list its only sortable
  -- column in exchange for hiding nothing.
  passport_country TEXT,
  dietary TEXT,
  accessibility TEXT,
  emergency_name TEXT,
  emergency_phone TEXT,
  emergency_relation TEXT,
  is_lead INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_travellers_reg
  ON group_travellers (registration_id);
CREATE INDEX IF NOT EXISTS idx_group_travellers_group
  ON group_travellers (group_id, user_id);
