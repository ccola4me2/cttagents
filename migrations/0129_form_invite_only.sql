-- A private form: one that can only be opened through the link an advisor sends to a client (Send to a client),
-- and not by anybody who finds or guesses its address. 0 is the ordinary open form every lead form is.
ALTER TABLE forms ADD COLUMN invite_only INTEGER NOT NULL DEFAULT 0;
