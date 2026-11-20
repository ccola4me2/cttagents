-- What a client does with a proposal: say yes, say no, ask a question, or ask for changes. The latest answer sits on the
-- proposal (response: accepted, declined, changes or question) and every note they sent is kept in order, so the advisor
-- reads the whole conversation in one place. Nothing here touches the book: a yes does not make a reservation, the advisor
-- does that when they are ready.
ALTER TABLE quick_proposals ADD COLUMN response TEXT;
ALTER TABLE quick_proposals ADD COLUMN responded_at INTEGER;

CREATE TABLE IF NOT EXISTS quick_proposal_messages (
  id          TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  body        TEXT,
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quick_proposal_messages ON quick_proposal_messages (proposal_id, created_at);
