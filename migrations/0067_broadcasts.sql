-- One message, sent once, to the people a list described at the moment it went.
--
-- Two tables rather than one, and the second is the point. A segment is a
-- question re-asked every time it is opened, which is right for "who should I
-- write to". A broadcast is a thing that happened to named people, which is
-- the opposite: the recipient rows are frozen when send is pressed, so the
-- record of who got Tuesday's email does not quietly change when somebody
-- books a cruise on Wednesday.
--
-- Freezing also makes the send resumable. A Worker invocation lasts seconds
-- and four hundred emails do not, so the cron drains the queued rows a batch
-- at a time and each row carries its own outcome. A pass that dies halfway
-- through loses nothing and sends nobody twice.

CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agency_id TEXT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  segment_id TEXT,
  rules_json TEXT NOT NULL DEFAULT '[]',
  -- draft | sending | sent | cancelled
  status TEXT NOT NULL DEFAULT 'draft',
  total INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_user ON broadcasts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id TEXT PRIMARY KEY,
  broadcast_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT,
  email TEXT NOT NULL,
  name TEXT,
  -- queued | sent | failed | skipped
  status TEXT NOT NULL DEFAULT 'queued',
  detail TEXT,
  sent_at TEXT
);

-- The same person cannot be on the same broadcast twice, whatever the list
-- said. Two clients sharing a household address is the ordinary way that
-- happens, and getting the newsletter twice is how somebody unsubscribes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bcast_once ON broadcast_recipients(broadcast_id, email);
CREATE INDEX IF NOT EXISTS idx_bcast_queue ON broadcast_recipients(status, broadcast_id);
