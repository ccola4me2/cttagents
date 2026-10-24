-- Whether each advisor is copied (bcc) on the automatic emails their clients are sent.
--
-- On by default. The first weeks of anything that writes to clients in an advisor's name are the weeks an advisor
-- most wants to see exactly what went, and an owner who is confident can switch it off.
ALTER TABLE agencies ADD COLUMN trip_emails_cc INTEGER NOT NULL DEFAULT 1;
