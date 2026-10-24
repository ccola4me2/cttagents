-- A name for the address confirmations are forwarded to, in place of the long private code.
--
--   import_alias   the advisor's first name, lower case, so conf-karen@ reaches Karen's waiting list. Unique
--                  among everybody, and empty for anybody whose name was already taken by somebody else.
--
-- The long code address keeps working beside it. A name can be guessed, so all it can do is put a message on the
-- advisor's Import page to be looked at: nothing becomes a reservation until the advisor presses the button.
ALTER TABLE users ADD COLUMN import_alias TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_import_alias ON users (import_alias) WHERE import_alias IS NOT NULL;

-- Everybody whose first name is theirs alone among the active advisors. The Group Desk is a place of its own and
-- has no import address.
UPDATE users
   SET import_alias = lower(replace(replace(first_name, ' ', ''), '-', ''))
 WHERE status = 'active' AND import_alias IS NULL
   AND first_name GLOB '[A-Za-z]*' AND length(first_name) >= 2
   AND agency_id NOT IN (SELECT id FROM agencies WHERE is_desk = 1)
   AND (SELECT COUNT(*) FROM users u2
         WHERE lower(u2.first_name) = lower(users.first_name) AND u2.status = 'active'
           AND u2.agency_id NOT IN (SELECT id FROM agencies WHERE is_desk = 1)) = 1;
