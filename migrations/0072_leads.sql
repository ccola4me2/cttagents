-- The marketing pipeline: somebody who rang, before they are a client.
--
-- Columns on `clients` rather than a `leads` table, and that is the whole
-- design decision. A lead is not a different kind of record from a client, it
-- is the same person earlier. Two tables would mean the person who rang in
-- March and booked in June exists twice, and the portal has already paid for
-- that lesson once with CRM contacts sitting alongside clients: you type a name
-- the system already knows and make a second copy of somebody.
--
-- So a lead is a client record with a stage on it. They arrive with one, they
-- move across the board, and they stop being a lead when a reservation exists,
-- which is derived and therefore cannot be stale. Nothing to tick, nothing to
-- migrate, and no second list to keep in step.
--
-- lead_stage NULL means "not on the pipeline", which is every client record
-- made by taking a booking. `source` already exists and says where they came
-- from, so it is not repeated here.
ALTER TABLE clients ADD COLUMN lead_stage TEXT;
ALTER TABLE clients ADD COLUMN lead_at INTEGER;
ALTER TABLE clients ADD COLUMN lead_asked_about TEXT;
ALTER TABLE clients ADD COLUMN lead_next_step TEXT;
ALTER TABLE clients ADD COLUMN lead_next_step_on TEXT;
