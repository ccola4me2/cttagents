-- Two fields the Cruise Planners client export carries and the record had
-- nowhere to put.
--
-- Nickname is what the client is actually called. "Barbara Polisei" is on the
-- passport and "Barb" is what she answers to, and an advisor greeting somebody
-- by their legal name sounds like a cold call. Twenty one of seventy nine rows
-- in the first export carry one.
--
-- Source is where they came from: Referral, Facebook Social Media, Friend or
-- Family. Forty six of seventy nine carry it, and it is the only field in the
-- whole record that answers "what is actually working", which is the question
-- behind every marketing decision in the portal.

ALTER TABLE clients ADD COLUMN nickname TEXT;
ALTER TABLE clients ADD COLUMN source TEXT;

-- Asked as "who came from Facebook" rather than by walking every client.
CREATE INDEX IF NOT EXISTS idx_clients_source ON clients (user_id, source);
