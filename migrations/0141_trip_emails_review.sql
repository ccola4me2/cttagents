-- Held for review: while an agency has this on, a client email that falls due waits for the owner to read it and press
-- Send, instead of going out on its own. Meant for the first week or two after the automatic emails are switched on.
ALTER TABLE agencies ADD COLUMN trip_emails_review INTEGER NOT NULL DEFAULT 0;
