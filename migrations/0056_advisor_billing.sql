-- What an advisor pays the agency for access to this portal.
--
-- Nothing to do with the money on a reservation. A client's payment goes to
-- the supplier and the agency never holds it; this is the agency's own
-- subscription revenue from its advisors, which is ordinary billing and
-- carries none of the seller-of-travel obligations that keep client funds out
-- of here. The two must never meet on screen: a client trip page has no
-- checkout, and a membership invoice is not a travel invoice.
--
-- Stripe is the source of truth for the money. This table is the local copy
-- the sign-in gate reads, kept current by webhook, so access does not depend
-- on being able to reach Stripe on the request.
CREATE TABLE IF NOT EXISTS advisor_billing (
  user_id            TEXT PRIMARY KEY,
  stripe_customer_id TEXT,
  subscription_id    TEXT,
  -- Stripe's own vocabulary, kept rather than translated: none, trialing,
  -- active, past_due, canceled, unpaid. Translating it here would mean
  -- deciding what a state means before knowing why it was reached.
  status             TEXT NOT NULL DEFAULT 'none',
  current_period_end INTEGER,
  -- When the read-only gate closes. Set when Stripe first reports trouble, so
  -- the advisor keeps working while Stripe retries the card rather than being
  -- stopped by a failure that usually resolves itself.
  grace_until        INTEGER,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_billing_status ON advisor_billing (status);
CREATE INDEX IF NOT EXISTS idx_billing_customer ON advisor_billing (stripe_customer_id);
