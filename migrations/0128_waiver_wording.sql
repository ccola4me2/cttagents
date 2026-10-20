-- The words of the travel insurance waiver, per agency. An owner may replace the explanation a client reads, the
-- line they tick, and the closing warning; each field is its own and a NULL one is the portal's built-in text.
-- {agency} and {advisor} are filled in when a client opens the page. Waivers already signed keep the words their
-- client saw (they are copied onto insurance_waivers when signed), so editing these never changes a record.
CREATE TABLE IF NOT EXISTS waiver_wording (
  agency_id   TEXT PRIMARY KEY,
  intro       TEXT,
  decline     TEXT,
  fine_print  TEXT,
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL
);
