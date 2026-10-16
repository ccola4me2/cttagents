-- Which group a group was repeated from.
--
-- A group is run again most years: same ship or resort, same crowd, a new sailing date. Repeating
-- one makes a new group from the old one, and this records where it came from so the old group's
-- page, once it has sailed, can point people to the next one instead of just saying it is over.
ALTER TABLE travel_groups ADD COLUMN repeated_from TEXT;
