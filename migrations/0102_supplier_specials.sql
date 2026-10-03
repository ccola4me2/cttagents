-- What the suppliers are running this week, kept where everybody can search it.
--
-- Not the same thing as `specials`. Those are one advisor's own deals, each with a
-- public page and an enquiry form. These are the suppliers' offers: the cruise
-- line sale, the tour operator's early booking bonus, the hotel's resort credit,
-- sent to the agency in a weekly list and wanted by whoever is on the phone with
-- a client on Tuesday afternoon.
--
-- So they belong to the agency, not to a person. agency_id is the fence, and
-- `added_by` is who uploaded it, kept for the record and never used to decide who
-- may see a row. Reading is for every advisor; adding, changing and removing is
-- the agency owner's, because a list that anybody can edit stops being the list
-- the suppliers sent.
--
-- Each upload is a list of its own, so a wrong one can be taken back out whole,
-- and the page can say which offers arrived this week.
CREATE TABLE IF NOT EXISTS supplier_special_lists (
  id            TEXT PRIMARY KEY,
  agency_id     TEXT NOT NULL,
  added_by      TEXT,
  title         TEXT,
  -- The date printed on the document, not the date it was uploaded.
  issued_on     TEXT,
  intro         TEXT,
  filename      TEXT,
  added_count   INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supplier_lists_agency ON supplier_special_lists (agency_id, created_at);

CREATE TABLE IF NOT EXISTS supplier_specials (
  id            TEXT PRIMARY KEY,
  agency_id     TEXT NOT NULL,
  added_by      TEXT,
  -- The newest list that carried this offer, and the one that first added it.
  list_id       TEXT,
  first_list_id TEXT,
  -- Cruise lines, Tours and land, Hotels and resorts, or whatever the document called it.
  category      TEXT,
  brand         TEXT NOT NULL,
  -- "TLN AmaMAX" in "AmaWaterways (TLN AmaMAX)": a programme within the brand.
  program       TEXT,
  offer         TEXT NOT NULL,
  -- The booking window as the supplier worded it, always kept, because the two
  -- dates below are only what could be read out of it.
  window_text   TEXT,
  starts_on     TEXT,
  ends_on       TEXT,
  code          TEXT,
  notes         TEXT,
  vendor_id     TEXT,
  -- Brand, programme and offer with the punctuation taken out. What makes next
  -- week's row the same offer as this week's, so it is updated and not doubled.
  match_key     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supplier_specials_agency ON supplier_specials (agency_id, ends_on);
CREATE INDEX IF NOT EXISTS idx_supplier_specials_key ON supplier_specials (agency_id, match_key);
CREATE INDEX IF NOT EXISTS idx_supplier_specials_list ON supplier_specials (agency_id, first_list_id);
