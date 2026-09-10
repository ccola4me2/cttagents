-- Two splits, because the advisor agreement has two.
--
-- "Agent retains 90% of commission earned on bookings Agent personally
-- generates" and "80% of commission earned on bookings resulting from leads
-- Company provides". One standing percentage per advisor could only ever
-- describe one of those, so every company lead was being paid at the personal
-- rate.
--
-- Both percentages live on the advisor rather than in the code, because the
-- agreement says they "may be changed only by a written amendment signed by
-- both Parties" -- which means they differ between advisors and change over
-- time, and neither is true of a constant.
ALTER TABLE users ADD COLUMN lead_split_pct REAL;

-- Which agreement a reservation falls under. Defaulting to personal follows
-- the agreement's own shape: personally generated is the ordinary case and
-- company-provided is the one that gets named.
ALTER TABLE bookings ADD COLUMN lead_source TEXT NOT NULL DEFAULT 'personal';

CREATE INDEX IF NOT EXISTS idx_bookings_lead_source ON bookings (user_id, lead_source);
