-- A task list that says what the task is, who it is about, and chases you.
--
-- Until now a task was a sentence, a date and a priority. That is a notepad.
-- What an advisor actually holds is "ring Margaret about her deposit at half
-- nine", "get the Simic documents out before the fourteenth", "Dana needs to
-- chase Seabourn about the group contract": a kind of work, a person it
-- concerns, a time it has to happen, and sometimes somebody else's name on it.
--
-- The reminder columns are the point. A due date nobody is told about is a
-- list you have to remember to open, which is the same problem the group
-- sign-ups had. Each notice is stamped once so a task cannot be sent twice,
-- and clearing the stamps is how a rescheduled task starts chasing again.

ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'other';
ALTER TABLE tasks ADD COLUMN due_time TEXT;
ALTER TABLE tasks ADD COLUMN client_id TEXT;
ALTER TABLE tasks ADD COLUMN group_id TEXT;

-- Whose list it is stays user_id. This is who put it there, so a task that
-- arrived from somebody else says so rather than appearing out of nowhere.
ALTER TABLE tasks ADD COLUMN assigned_by TEXT;

ALTER TABLE tasks ADD COLUMN reminded_at INTEGER;
ALTER TABLE tasks ADD COLUMN overdue_reminded_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks (due_date, done_at);
