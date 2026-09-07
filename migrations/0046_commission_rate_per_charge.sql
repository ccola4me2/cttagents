-- The rate a charge earns, so the commission is worked out rather than typed.
--
-- Commission was a number the advisor entered per traveller column, copied off
-- a confirmation and totalled by hand before that. What they actually know is
-- the rate: sixteen per cent on the fare, ten on the insurance, nothing on the
-- taxes. Given the rate, the money follows from the amounts already in the
-- grid, and it follows again the moment a fare changes.
--
-- Kept per line rather than per booking because the rate belongs to the kind
-- of charge: a vendor pays one rate on the fare and another on a package, and
-- an advisor who has to average them by hand is doing the arithmetic this is
-- meant to remove.
--
-- commission_cents stays the stored truth. Everything downstream reads it, and
-- a rate is a way of filling it in rather than a replacement for it: a vendor
-- who pays an odd number that matches no rate is still recorded exactly.

ALTER TABLE booking_pricing ADD COLUMN commission_pct REAL;
