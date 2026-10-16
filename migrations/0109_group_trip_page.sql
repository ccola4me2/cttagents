-- What a group's own page has to be able to say.
--
-- Until now a group held what the agency needs to sell it: the block, the
-- option date, the rate grid. Its public page could therefore only take a name
-- and an email, because there was nothing else on the record worth showing.
--
-- These are the facts a traveller asks for before they will put a deposit
-- down, and every one of them lives on the group rather than on a reservation,
-- because none of them exists yet when somebody is deciding.
--
-- The three dates are the supplier's, not the agency's. A deposit due date on
-- a group is "the date this block needs money against it", which is a
-- different thing from the deposit date on any one reservation taken out of it.
ALTER TABLE travel_groups ADD COLUMN deposit_due TEXT;
ALTER TABLE travel_groups ADD COLUMN final_payment_due TEXT;
-- When passport details have to be in. Its own date because it is the one
-- deadline the traveller can miss without any money moving, and so the one
-- nothing else would chase.
ALTER TABLE travel_groups ADD COLUMN passport_due TEXT;

-- The supplier's group booking number. Text, not a number: a cruise line that
-- writes 04589 keeps its leading nought, the same reason proposal_id is text.
ALTER TABLE travel_groups ADD COLUMN group_number TEXT;

-- Questions and answers, as a JSON array of {q, a}. A column rather than a
-- table because an FAQ is written and reordered as a whole, never queried, and
-- never joined to anything.
ALTER TABLE travel_groups ADD COLUMN faq_json TEXT;

-- What somebody is agreeing to when they register, and what each half of the
-- money is. Two separate terms because they are two separate transactions: the
-- trip cost goes to the travel supplier through the agency and follows the
-- supplier's cancellation tiers, and the agency's own fee is the agency's and
-- usually does not come back at all. A registration form that shows one total
-- and one set of terms is hiding the half somebody will be angry about later.
ALTER TABLE travel_groups ADD COLUMN terms TEXT;
ALTER TABLE travel_groups ADD COLUMN agency_fee_cents INTEGER;
ALTER TABLE travel_groups ADD COLUMN fee_terms TEXT;
ALTER TABLE travel_groups ADD COLUMN trip_terms TEXT;
