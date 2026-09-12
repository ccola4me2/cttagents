-- Who has asked not to be emailed.
--
-- Nothing in the portal has ever recorded this, so an automation could mail
-- somebody who had already said stop. That was survivable while every send was
-- about a booking the person actually holds, and stops being survivable the
-- day anything goes to a list.
--
-- Held per agency rather than per advisor. A client who unsubscribes is done
-- with the agency, not with the one advisor who happened to send the last
-- email, and a suppression list that a colleague can walk around is not a
-- suppression list. Not held globally either: a person on two agencies' books
-- has two relationships and can end one without ending the other.
--
-- Addresses are stored lowercased and matched exactly. Normalising further --
-- stripping dots, cutting +tags -- guesses at a provider's rules and would
-- suppress an address the person never gave anybody.

CREATE TABLE IF NOT EXISTS email_suppression (
  id          TEXT PRIMARY KEY,
  agency_id   TEXT,
  email       TEXT NOT NULL,
  -- unsubscribed | complained | bounced | manual
  reason      TEXT NOT NULL DEFAULT 'unsubscribed',
  -- Where it came from: a footer link, a Resend webhook, an advisor typing it.
  source      TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL
);

-- The question asked before every marketing send, so it has to be one lookup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppression_who
  ON email_suppression (agency_id, email);
