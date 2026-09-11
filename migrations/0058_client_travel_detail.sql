-- Everything a reservation needs, kept on the person rather than retyped.
--
-- A client record held a name, an email, a phone and two dates. Everything a
-- cruise line actually wants -- the name exactly as the passport spells it, a
-- date of birth, the passport itself -- lived on the traveller rows of one
-- booking, so the same details were typed again for every trip that person
-- took, and a passport renewed last spring was still wrong on this autumn's
-- sailing.
--
-- Held as columns rather than a blob because the point of having them is to be
-- able to ask questions: whose passport expires inside six months of the date
-- they sail, which is the ordinary reason somebody is turned away at the pier.

-- The name on the document, which is not always the name on the conversation.
-- "Bob" books; "Robert James Whitfield" boards.
ALTER TABLE clients ADD COLUMN legal_first TEXT;
ALTER TABLE clients ADD COLUMN legal_middle TEXT;
ALTER TABLE clients ADD COLUMN legal_last TEXT;
-- Free text rather than a fixed pair. Vendors want a letter, people are not a
-- letter, and the advisor is the one who knows what the document says.
ALTER TABLE clients ADD COLUMN gender TEXT;
ALTER TABLE clients ADD COLUMN citizenship TEXT;

ALTER TABLE clients ADD COLUMN passport_number TEXT;
ALTER TABLE clients ADD COLUMN passport_country TEXT;
ALTER TABLE clients ADD COLUMN passport_issued TEXT;
ALTER TABLE clients ADD COLUMN passport_expiry TEXT;

ALTER TABLE clients ADD COLUMN address1 TEXT;
ALTER TABLE clients ADD COLUMN address2 TEXT;
ALTER TABLE clients ADD COLUMN city TEXT;
ALTER TABLE clients ADD COLUMN state TEXT;
ALTER TABLE clients ADD COLUMN postcode TEXT;
ALTER TABLE clients ADD COLUMN country TEXT;

-- Past-guest numbers, one per cruise line, so a list rather than a column:
-- Royal Caribbean and Carnival and Princess all issue their own and somebody
-- who sails often has several. JSON of [{line, number}].
ALTER TABLE clients ADD COLUMN loyalty_json TEXT;
ALTER TABLE clients ADD COLUMN known_traveler TEXT;
ALTER TABLE clients ADD COLUMN redress TEXT;

-- The question this table now exists to answer.
CREATE INDEX IF NOT EXISTS idx_clients_passport_expiry ON clients (user_id, passport_expiry);
