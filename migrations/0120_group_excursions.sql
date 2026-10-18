-- A link a group's page offers for looking at shore excursions: the advisor's own booking site or
-- the cruise line's. Shown under the itinerary as a button. https only, checked when it is saved.
ALTER TABLE travel_groups ADD COLUMN excursions_url TEXT;
