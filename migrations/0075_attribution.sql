-- Where a client came from, in a word the portal can count.
--
-- `source` has been on this table since the beginning and it is free text. So
-- Facebook, facebook, FB and "face book" are four channels, "Sandra sent her"
-- and "referral from Sandra" are two more, and no query can add any of them up.
-- What it is good at is the detail: which form, whose party, which post. That
-- is worth keeping and worth not counting.
--
-- So the channel gets a column of its own from a fixed list, and `source` stays
-- exactly what it was, the note underneath. Nothing already typed is rewritten
-- or thrown away.
ALTER TABLE clients ADD COLUMN source_kind TEXT;

-- Who sent them, when the channel is a referral.
--
-- "Referral: 8 clients" is a statistic. "These eight came from these three
-- people" is a phone call, which is the whole reason an advisor would want the
-- number. Points at another clients row, and stays null for every other channel.
ALTER TABLE clients ADD COLUMN referred_by_client_id TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_source_kind ON clients(user_id, source_kind);
CREATE INDEX IF NOT EXISTS idx_clients_referred_by ON clients(referred_by_client_id);

-- Backfill, and only where the words are not ambiguous.
--
-- A guess here is worse than a blank. A blank says nobody recorded it, which is
-- true and which the report can say out loud; a wrong channel is a number
-- somebody makes a decision on. Everything that does not match one of these
-- stays null and is counted as "not recorded".
UPDATE clients SET source_kind = 'website'
 WHERE source_kind IS NULL AND source LIKE 'Form:%';

-- "Friend/Family" is the commonest thing written in this box and it is a
-- referral in every reading of it.
UPDATE clients SET source_kind = 'referral'
 WHERE source_kind IS NULL
   AND (source LIKE '%referr%' OR source LIKE '%referal%' OR source LIKE '%sent by%'
        OR source LIKE '%friend%' OR source LIKE '%family%');

UPDATE clients SET source_kind = 'social'
 WHERE source_kind IS NULL
   AND (source LIKE '%facebook%' OR source LIKE '%instagram%' OR source LIKE '%tiktok%'
        OR source LIKE '%social%');

UPDATE clients SET source_kind = 'website'
 WHERE source_kind IS NULL
   AND (source LIKE '%website%' OR source LIKE '%web site%' OR source LIKE '%web form%');

UPDATE clients SET source_kind = 'group'
 WHERE source_kind IS NULL AND source LIKE '%group%';

UPDATE clients SET source_kind = 'walk_in'
 WHERE source_kind IS NULL AND (source LIKE '%walk in%' OR source LIKE '%walk-in%');

-- Somebody already chose "Other" from a list of one. It is not a guess to keep
-- their answer; every other word in this box is left for a person to decide.
UPDATE clients SET source_kind = 'other'
 WHERE source_kind IS NULL AND LOWER(TRIM(source)) = 'other';
