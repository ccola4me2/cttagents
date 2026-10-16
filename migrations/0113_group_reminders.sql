-- When this group's deadlines were last mentioned to its advisor.
--
-- A date rather than a stamp, because the rule is one digest per group per
-- day: an option date, a deposit date and a passport date can all be close at
-- once, and three emails about one trip in one morning is how a reminder
-- becomes something people filter.
ALTER TABLE travel_groups ADD COLUMN reminded_on TEXT;
