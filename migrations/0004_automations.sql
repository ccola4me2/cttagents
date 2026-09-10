-- CTT's own automation engine.
--
-- The upstream workflow builder has no create or edit API, so automations
-- there can only be listed and triggered. These are the portal's own: defined
-- here, executed here, and independent of that platform.
--
-- Design: a run is a durable row, not an in-memory job. A Worker invocation is
-- short lived and an automation can wait days between steps, so progress has
-- to survive in the database. Each run stores which step it is on and when it
-- is next due; a cron picks up whatever is due and advances it.

CREATE TABLE IF NOT EXISTS automations (
  id            TEXT PRIMARY KEY,
  location_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  -- form.submitted | contact.created | booking.created | booking.final_payment_due
  trigger_type  TEXT NOT NULL,
  -- Narrows the trigger, e.g. {"formId":"..."} so only one form fires it.
  trigger_config_json TEXT,
  -- Ordered steps: [{action, ...params}]
  steps_json    TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  runs_started  INTEGER NOT NULL DEFAULT 0,
  runs_done     INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_loc ON automations (location_id, active);
CREATE INDEX IF NOT EXISTS idx_auto_trigger ON automations (location_id, trigger_type, active);

CREATE TABLE IF NOT EXISTS automation_runs (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  location_id   TEXT NOT NULL,
  contact_id    TEXT,
  contact_email TEXT,
  contact_name  TEXT,
  -- Whatever fired it: the submission, the booking, the contact.
  context_json  TEXT,
  step_index    INTEGER NOT NULL DEFAULT 0,
  -- pending | waiting | done | failed | cancelled
  status        TEXT NOT NULL DEFAULT 'pending',
  next_run_at   INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (automation_id) REFERENCES automations (id) ON DELETE CASCADE
);
-- The engine's hot query: what is due right now.
CREATE INDEX IF NOT EXISTS idx_runs_due ON automation_runs (status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_runs_auto ON automation_runs (automation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_contact ON automation_runs (contact_id);

CREATE TABLE IF NOT EXISTS automation_logs (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  step_index  INTEGER NOT NULL,
  action      TEXT NOT NULL,
  status      TEXT NOT NULL,          -- ok | skipped | error
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_run ON automation_logs (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_logs_auto ON automation_logs (automation_id, created_at);
