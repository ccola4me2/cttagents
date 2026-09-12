-- An option can belong to one part of a trip rather than to all of it.
--
-- Until now a quote option was a whole alternative: the Caribbean version of
-- the trip against the Alaska version, and the client picks one. That is how
-- a package is sold and not how a cruise is. A cruise is one sailing with
-- choices inside it: which cabin grade, which insurance, which pre-night
-- hotel. Offering those as whole alternatives means one option per
-- combination, which is four options to ask two questions and sixteen to ask
-- four.
--
-- So an option may name the component it is an alternative for. Options with
-- no component stay what they were, the whole-trip alternatives, and nothing
-- already recorded changes meaning.
--
-- The grouping matters for more than display. "One chosen at a time" used to
-- clear every option on the reservation, which with component options would
-- mean choosing a cabin unchose the insurance. It clears the group instead.

ALTER TABLE quote_options ADD COLUMN component_id TEXT;

-- Read as "the options for this part of this trip" on every render of the
-- proposal, by the advisor and by the client.
CREATE INDEX IF NOT EXISTS idx_quote_options_group
  ON quote_options (booking_id, component_id, sort_order);
