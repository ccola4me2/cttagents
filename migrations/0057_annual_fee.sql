-- The Annual Program Fee, which runs on its own clock.
--
-- Two charges, two cycles: $29.95 on the 1st of each month, and $250 every
-- 1 October. Stripe cannot hold both on one subscription -- every price on a
-- subscription shares an interval -- so there are two, and this is where the
-- second one is remembered.
--
-- Only the monthly decides whether an account is read-only. The annual is a
-- once-a-year invoice the agency will chase like any other, and locking
-- somebody out of their own book over an insurance renewal is a heavier
-- answer than the question deserves.
ALTER TABLE advisor_billing ADD COLUMN annual_subscription_id TEXT;
ALTER TABLE advisor_billing ADD COLUMN annual_status TEXT;
ALTER TABLE advisor_billing ADD COLUMN annual_period_end INTEGER;
