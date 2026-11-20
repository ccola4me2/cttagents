-- A quote started from a lead. The proposal stays by itself, with no client record and no reservation, and only
-- remembers which lead it was for, so the lead's card can list it. lead_id is the clients row the lead lives on.
-- Turning the proposal into a reservation later uses that same person, so they leave the lead board by booking.
ALTER TABLE quick_proposals ADD COLUMN lead_id TEXT;

CREATE INDEX IF NOT EXISTS idx_quick_proposals_lead ON quick_proposals (user_id, lead_id);
