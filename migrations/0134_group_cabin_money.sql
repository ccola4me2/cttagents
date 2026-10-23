-- What a cabin costs and what has been paid on it, as the cruise line's confirmation says. Whole cents. Nought is
-- not known or nothing paid, and the sheet shows neither as money.
ALTER TABLE group_cabins ADD COLUMN total_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_cabins ADD COLUMN paid_cents INTEGER NOT NULL DEFAULT 0;
