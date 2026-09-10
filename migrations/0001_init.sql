-- CTT Agent Portal, initial schema.
--
-- Apply with either:
--   npx wrangler d1 migrations apply cttagents --remote
-- or by pasting this file into the D1 "Console" tab in the Cloudflare dashboard.
--
-- Scope note: contacts, opportunities, conversations and calendars are NOT
-- stored here. GoHighLevel is the system of record for those and the portal
-- reads them live through the API. D1 holds what GHL cannot model: portal
-- accounts, sessions, and travel-specific booking and commission records.

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,        -- pbkdf2$<iterations>$<salt_b64>$<hash_b64>
  first_name        TEXT,
  last_name         TEXT,
  phone             TEXT,
  agency_name       TEXT,

  -- 'advisor' or 'admin'. Admins approve accounts and see every advisor.
  role              TEXT NOT NULL DEFAULT 'advisor',
  -- 'pending' until an admin approves, then 'active'. 'suspended' locks out.
  status            TEXT NOT NULL DEFAULT 'pending',

  -- GoHighLevel binding. NULL location falls back to GHL_DEFAULT_LOCATION_ID
  -- in wrangler.toml, which covers the single shared sub-account model. Set
  -- per row when an advisor has their own sub-account.
  ghl_location_id   TEXT,
  -- GHL user id inside that location, used to scope records to this advisor.
  ghl_user_id       TEXT,

  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_login_at     INTEGER,
  approved_at       INTEGER,
  approved_by       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,           -- sha256(session token) hex; raw token lives only in the cookie
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         TEXT PRIMARY KEY,           -- sha256(reset token) hex
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reset_user ON password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_reset_expires ON password_reset_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- Bookings and trips
--
-- The travel-specific layer. A booking optionally points back at the GHL
-- contact and opportunity it came from, so the portal can show them together
-- without duplicating contact data into D1.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,      -- owning advisor
  ghl_contact_id      TEXT,
  ghl_opportunity_id  TEXT,

  client_name         TEXT NOT NULL,
  supplier            TEXT,               -- cruise line, resort brand, tour operator
  product_type        TEXT NOT NULL DEFAULT 'cruise',  -- cruise | resort | package | air | other
  product_name        TEXT,               -- ship or property name
  destination         TEXT,
  confirmation_number TEXT,

  depart_date         TEXT,               -- ISO yyyy-mm-dd
  return_date         TEXT,
  deposit_due         TEXT,
  final_payment_due   TEXT,

  travellers          INTEGER NOT NULL DEFAULT 1,
  gross_cents         INTEGER NOT NULL DEFAULT 0,
  commission_cents    INTEGER NOT NULL DEFAULT 0,
  commission_status   TEXT NOT NULL DEFAULT 'pending',  -- pending | invoiced | paid
  status              TEXT NOT NULL DEFAULT 'booked',   -- quoted | booked | travelled | cancelled

  notes               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings (user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (user_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_depart ON bookings (user_id, depart_date);
CREATE INDEX IF NOT EXISTS idx_bookings_final_due ON bookings (user_id, final_payment_due);
CREATE INDEX IF NOT EXISTS idx_bookings_contact ON bookings (ghl_contact_id);

-- ---------------------------------------------------------------------------
-- Activity log: powers "recent activity" on the dashboard and gives admins an
-- audit trail of what happened in the portal (not in GHL).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- login | booking.create | booking.update | lead.note | ...
  subject    TEXT,                        -- human readable one liner
  meta_json  TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log (user_id, created_at);
