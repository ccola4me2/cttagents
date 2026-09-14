-- What a client said when they got home, and who they sent you.
--
-- The portal already knew the moment: welcomeHomeCandidates finds everybody who
-- is back and has not been rung, and the dashboard has listed them for a while.
-- Nothing asked them anything. For a travel advisor a review and a referral are
-- the marketing, and the one minute after somebody gets home is when both are
-- free.
--
-- One review per reservation, because a trip is the thing being reviewed.
-- Nullable rating and body: a row can exist because the ask was sent, before
-- anybody has answered, and "asked and heard nothing" is a fact worth keeping.
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  -- The advisor, because the fence in this database is user_id and a review is
  -- read on screens that are scoped by it.
  user_id TEXT NOT NULL,
  client_id TEXT,
  rating INTEGER,
  body TEXT,
  -- How they want to be credited, which is not always their name on the
  -- booking, and whether they said it may be quoted at all. Nothing is public
  -- unless somebody ticked a box saying so.
  author_name TEXT,
  consent_public INTEGER NOT NULL DEFAULT 0,
  asked_at INTEGER,
  asked_count INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (booking_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id, submitted_at);
