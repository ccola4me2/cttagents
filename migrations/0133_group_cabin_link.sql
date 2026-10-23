-- A cabin on a group's sheet can be one of the portal owner's own reservations, kept up to date from it.
--
--   booking_id   the reservation it is, in the owner's own account. Such a row shows the cabin, category, guests,
--                booking number and where it stands as the reservation has them, and cannot be changed on the
--                sheet except for its TC flag and notes.
--   hidden       a linked row somebody took off the sheet. It stays, hidden, so it is not put back on the next load.
ALTER TABLE group_cabins ADD COLUMN booking_id TEXT;
ALTER TABLE group_cabins ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_cabins_booking ON group_cabins (group_id, booking_id) WHERE booking_id IS NOT NULL;
