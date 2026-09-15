-- Which payment rows are a copy of a date on the reservation.
--
-- The trip cost has followed the pricing grid since the grid existed: fill the
-- breakdown in and the reservation's headline total is rewritten from it, so
-- the two can never disagree. The dates never got that treatment. Deposit due
-- and final payment due are typed on the reservation, "Build schedule" copies
-- them into payment rows, and from that moment the two are strangers. Move the
-- date on the reservation and the row stays put. Move the row and the
-- reservation stays put. Half the screens in the portal read one and half read
-- the other, so two of them can disagree about when the money is due and
-- neither is lying.
--
-- So a row now records whether it is a copy. A copy follows its reservation.
-- The moment somebody edits the row by hand it stops following, because they
-- have said something more specific than the reservation says, and software
-- that overwrites that is software people stop trusting.
ALTER TABLE booking_payments ADD COLUMN from_booking INTEGER NOT NULL DEFAULT 0;

-- Everything the generator wrote, which is exactly the set that was a copy.
-- It stamps its own rows with these two notes and nothing else does.
-- A prefix, not a pattern with a tail on it. D1 refused
-- 'Internal reminder,% days before the vendor deadline' outright with "LIKE or
-- GLOB pattern too complex", so the migration would have failed for anybody
-- applying it after me. The generator's note always starts with these two
-- words, so a prefix selects exactly the same rows and is cheaper besides.
UPDATE booking_payments SET from_booking = 1
 WHERE notes = 'Vendor deadline, generated from the reservation'
    OR notes LIKE 'Internal reminder,%';
