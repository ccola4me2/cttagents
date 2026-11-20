-- The trip a quote describes: vendor, ship, dates, cabin, who is going, a price for each charge for each person, and the
-- deposit. One JSON document on the proposal, so a quote can look like a reservation without being one. Copied onto a
-- reservation only when the advisor says the client accepted.
ALTER TABLE quick_proposals ADD COLUMN trip_json TEXT;
