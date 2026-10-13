-- Vendor confirmations forwarded by email, held until the advisor has checked them.
--
-- The text is what the confirmation reader will be given again when the advisor opens it, so it is
-- kept as it was read and the fields are not stored: a reader that improves reads the same message
-- better the next time. Nothing here is a reservation. A row exists until it is turned into one or
-- dismissed, and a row nobody opened goes after forty five days, because the text carries a client's
-- name and what they paid.
CREATE TABLE IF NOT EXISTS inbox_confirmations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  from_addr    TEXT,
  subject      TEXT,
  source       TEXT NOT NULL DEFAULT 'text',
  text         TEXT NOT NULL,
  summary_json TEXT,
  status       TEXT NOT NULL DEFAULT 'waiting',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inbox_user ON inbox_confirmations (user_id, status, created_at);
