-- A person on the Group Desk may use the same email address they use elsewhere on the portal. Accounts are
-- one to an address, so their desk account keeps an internal address of its own and remembers the real one
-- here, which is what they type to sign in at the desk and what is shown as theirs.
ALTER TABLE users ADD COLUMN desk_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_desk_email ON users (desk_email) WHERE desk_email IS NOT NULL;
