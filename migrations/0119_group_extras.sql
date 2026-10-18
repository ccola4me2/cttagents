-- More for a group's page to say: amenities (onboard credit and the like), drink packages and
-- enhancements. Each is a short list written as JSON, one entry per line on the group's screen:
-- [{ "name": "...", "price": "...", "note": "..." }]. The price is words rather than a number, since
-- what an advisor writes is "$100 per cabin" or "Included" or "$59.99 per person per day".
ALTER TABLE travel_groups ADD COLUMN amenities_json TEXT;
ALTER TABLE travel_groups ADD COLUMN drinks_json TEXT;
ALTER TABLE travel_groups ADD COLUMN enhancements_json TEXT;
