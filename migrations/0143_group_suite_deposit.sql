-- A suite deposit beside the standard one.
--
-- A cruise line asks for more down to hold a suite than a stateroom, so a group needs two amounts: the standard deposit that every other
-- cabin pays, and a higher one for the suites. Both per guest, like every other number on a rate band. Empty means the suites pay the
-- standard deposit.
ALTER TABLE travel_groups ADD COLUMN suite_deposit_per_guest_cents INTEGER;
