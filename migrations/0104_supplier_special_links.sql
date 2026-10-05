-- Consumer promotions from the Travel Leaders Network, which come with a page of their own.
--
-- The weekly Word list is the suppliers' offers to agents. The TLN promo pull is the
-- consumer side of the same thing: each promotion has a headline, a travel period, and
-- a page on travelleaders.com that carries the agency's agent id, so a client who
-- follows it is credited to the agency. Those four things have nowhere to live in the
-- columns the Word list needed, and the link in particular must be kept exactly as
-- it was given, since the agent id inside it is what routes the lead.
--
-- NULL and 0 on rows that came from a Word list, which have none of them.
ALTER TABLE supplier_specials ADD COLUMN headline TEXT;
ALTER TABLE supplier_specials ADD COLUMN travel_period TEXT;
ALTER TABLE supplier_specials ADD COLUMN link TEXT;
ALTER TABLE supplier_specials ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
