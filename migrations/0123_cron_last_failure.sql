-- Keep the last failure of each scheduled job, so it can still be read after later passes have worked.
-- last_error is cleared by the next good run, which is right for "is it failing now" and loses the
-- reason a job failed once in ten thousand passes. These two are only ever replaced by a newer failure.
ALTER TABLE cron_jobs ADD COLUMN last_failure TEXT;
ALTER TABLE cron_jobs ADD COLUMN last_failure_at INTEGER;
