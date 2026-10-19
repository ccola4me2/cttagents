-- A proposal an advisor puts together and sends without it being a quote or a reservation: a cover
-- picture, a note, sections with pictures and words, an optional price, and a link to send. It lives on its
-- own and goes by itself after its expiry. It can be turned into a quoted reservation later, which is when
-- it first touches the advisor's book.
--
--   code          the address of the public page, /p/<code>; the link is the credential
--   for_name      who it is for, as the advisor wants it to read ("Sarah and Mike")
--   sections_json [{ heading, body, price, imageId }]
--   expires_at    when the link stops working; the proposal and its pictures are removed a week after
--   booking_id    set when it has been turned into a quote
CREATE TABLE IF NOT EXISTS quick_proposals (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  code            TEXT NOT NULL,
  title           TEXT NOT NULL,
  for_name        TEXT,
  note            TEXT,
  cover_image_id  TEXT,
  sections_json   TEXT,
  total_text      TEXT,
  expires_at      INTEGER,
  sent_count      INTEGER NOT NULL DEFAULT 0,
  last_sent_at    INTEGER,
  view_count      INTEGER NOT NULL DEFAULT 0,
  first_viewed_at INTEGER,
  booking_id      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_proposals_code ON quick_proposals (code);
CREATE INDEX IF NOT EXISTS idx_quick_proposals_user ON quick_proposals (user_id, updated_at);

-- The pictures on a proposal, kept in the private bucket and served through the Worker.
CREATE TABLE IF NOT EXISTS quick_proposal_images (
  id          TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  bytes       INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quick_proposal_images ON quick_proposal_images (proposal_id);
