-- The day a commission check reached the bank. Empty means it has not been confirmed there yet, and the pay run says so
-- before an advisor is paid out of it. Checks recorded before this existed are taken as deposited the day they arrived,
-- because they have already been paid out of.
ALTER TABLE commission_checks ADD COLUMN deposited_on TEXT;
UPDATE commission_checks SET deposited_on = COALESCE(received_on, date(created_at, 'unixepoch')) WHERE deposited_on IS NULL;
