-- Three things a task list needs once it is actually used.
--
-- Repeating work. "Check final payments every Monday" is one task that comes
-- back, not fifty-two typed in advance. The next one is made when the last is
-- ticked off, so a list of open tasks stays a list of work rather than a
-- calendar of everything the year holds.
--
-- Checklists. "Prepare the Simic documents" is six things, and a task that
-- cannot say so is either ticked off early or sits there looking untouched
-- while five of the six are done.
--
-- Templates. The same four tasks follow every cruise: chase the deposit, take
-- the final payment, get documents out, welcome them home. Typing them per
-- booking is how one gets forgotten on the trip that mattered.

ALTER TABLE tasks ADD COLUMN repeat_rule TEXT;
ALTER TABLE tasks ADD COLUMN repeat_until TEXT;

-- Which task this one was born from. Only so that un-ticking can undo it: a
-- mis-click that makes next week's task and then leaves it there is litter
-- somebody has to notice and delete by hand.
ALTER TABLE tasks ADD COLUMN repeat_of TEXT;

CREATE TABLE IF NOT EXISTS task_items (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  label      TEXT NOT NULL,
  done_at    INTEGER,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_items ON task_items (task_id, position);

CREATE TABLE IF NOT EXISTS task_templates (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'other',
  priority     TEXT NOT NULL DEFAULT 'normal',
  notes        TEXT,
  -- Which date the task hangs off, and how many days either side of it. The
  -- anchor is a column name on the reservation rather than a date, because a
  -- template written today has to work for a trip booked next year.
  anchor       TEXT NOT NULL DEFAULT 'depart_date',
  offset_days  INTEGER NOT NULL DEFAULT 0,
  -- Blank means every kind of trip. A cruise and a hotel stay do not have the
  -- same paperwork, and a template that fires on both is one somebody deletes.
  product_type TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_templates ON task_templates (user_id, position);
