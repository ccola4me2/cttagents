-- A client signs in, rather than holding a link.
--
-- /c/<hub_code> works and is staying: the link is the credential, and every
-- one already sent keeps working. What it cannot do is tell two people apart.
-- A link forwarded to a sister is the same link, a household of four share one
-- view, and taking access away from one person breaks it for everybody.
--
-- So: identity by email, proved by a one-time link sent to that email. No
-- password for a client. Somebody who signs in four times a year should not
-- have a password to forget, and an advisor should not be fielding resets on a
-- Saturday.
--
-- The identity is the EMAIL, not a client row. clients is unique on
-- (user_id, name), so the same person is two rows when two advisors both know
-- them. Signing in as an email and fencing on the agency means one login shows
-- everything the agency holds for that person, which is the thing the shared
-- link could never do.
--
-- agency_id on both tables, so the fence is on the row rather than worked out
-- by a join every time, and a token minted for one agency can never open
-- another.

CREATE TABLE IF NOT EXISTS client_sessions (
  -- The id IS the token, the same as sessions for advisors.
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  agency_id   TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_client_sessions_email
  ON client_sessions (email, agency_id);
CREATE INDEX IF NOT EXISTS idx_client_sessions_expires
  ON client_sessions (expires_at);

CREATE TABLE IF NOT EXISTS client_login_tokens (
  -- Single use and short lived. used_at is set the moment it is redeemed, so
  -- a link read twice out of an inbox does not open a second session.
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  agency_id   TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_client_login_tokens_email
  ON client_login_tokens (email, created_at);
