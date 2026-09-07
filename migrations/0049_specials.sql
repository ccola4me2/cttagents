-- Deals worth telling people about, and when each one dies.
--
-- CP Maxx has a Special Sales screen fed by head office, plus a promotions
-- calendar showing what is running. There is no such feed here and inventing
-- one would mean a screen of promos nobody maintains, rotting inside a month.
-- So these are the advisor's own: the deal they were sent, the deal they
-- negotiated, the group rate with three cabins left.
--
-- Two things a list of deals in an inbox cannot do, and the whole reason this
-- is a table rather than a note. It knows when an offer expires, so the page
-- can lead with what dies on Friday instead of what was posted first. And each
-- one has an address of its own to send people to, which means the enquiry
-- arrives attached to the deal that pulled it rather than as another name with
-- no idea where it came from.

CREATE TABLE IF NOT EXISTS specials (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  -- The public address. Unique across every advisor because it is a URL.
  code         TEXT NOT NULL,
  headline     TEXT NOT NULL,
  vendor       TEXT,
  vendor_id    TEXT,
  product_type TEXT NOT NULL DEFAULT 'cruise',
  ship         TEXT,
  destination  TEXT,
  depart_date  TEXT,
  return_date  TEXT,
  nights       INTEGER,
  -- The headline number and what it buys. Cents, like every other amount here.
  price_cents  INTEGER,
  price_basis  TEXT,
  -- What is in it, and the small print the client will ask about anyway.
  inclusions   TEXT,
  terms        TEXT,
  blurb        TEXT,
  -- When the offer runs. `ends_on` is the one that matters: an expired deal
  -- quoted to a client is worse than no deal at all.
  starts_on    TEXT,
  ends_on      TEXT,
  -- Off until the advisor says so, so a half-written deal has no live page.
  published    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_specials_code ON specials (code);
CREATE INDEX IF NOT EXISTS idx_specials_user ON specials (user_id, ends_on);

-- Somebody who asked about one. Kept beside the deal rather than dropped into
-- the general lead pile, because which deal pulled is the only way to find out
-- which deal to run again.
CREATE TABLE IF NOT EXISTS special_leads (
  id          TEXT PRIMARY KEY,
  special_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  party_size  INTEGER,
  notes       TEXT,
  contact_id  TEXT,
  -- Set when the enquiry becomes a real reservation, so a name that has been
  -- acted on stops looking like one that has not.
  booking_id  TEXT,
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  FOREIGN KEY (special_id) REFERENCES specials (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_special_leads ON special_leads (special_id, created_at);
CREATE INDEX IF NOT EXISTS idx_special_leads_user ON special_leads (user_id, created_at);
