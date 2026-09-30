-- The third and fourth guest in a cabin.
--
-- 0098 made the proposal's rate grid rows, with one price per guest. That is
-- the right shape for a double cabin and wrong for a quad. Everywhere in this
-- trade the first two guests in a cabin pay the main rate and anybody beyond
-- that pays something different, an extra adult rate or an extra child rate,
-- and the second real proposal had exactly that row: two guests at $881.60 and
-- two more at $464.00.
--
-- Without the extra the grid row could not be added up. The figures on it would
-- be right and the total beside them would be unexplained, which is how a
-- wrong number hides: nobody can check a total against figures that are not
-- there.
--
-- Cents, like every other amount here, and NOT NULL with a default of nothing,
-- so every row already stored reads as what it was, a cabin with no extras.
ALTER TABLE group_rates ADD COLUMN extra_adult_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_rates ADD COLUMN extra_child_cents INTEGER NOT NULL DEFAULT 0;
