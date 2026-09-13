-- Did the nightly work actually happen?
--
-- The scheduled handler runs a dozen jobs and each one is wrapped in a catch
-- that writes to console.error. That is the right shape, because one broken
-- job must not stop the other eleven, and it has a cost nobody has paid yet:
-- a job that has been throwing since March looks exactly like a job with
-- nothing to do. The reminders stop going out and the first person to notice
-- is a client who was never chased about a final payment.
--
-- One row per job, rewritten on every pass. What matters is the pair: when it
-- last ran at all, and when it last ran without throwing. A job whose last run
-- is recent and whose last good run is three weeks old is the exact failure
-- the console was swallowing.

CREATE TABLE IF NOT EXISTS cron_jobs (
  name TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  last_ms INTEGER,
  runs INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
);
