-- The tasks that follow every trip belong to the agency, not to one advisor.
--
-- Same argument as the supplier directory, and the same shape of problem. A
-- template is the agency's process written down: chase the deposit three days
-- before it is due, documents a fortnight before departure, ring them when
-- they are home. Held per advisor, a new joiner books their first cruise and
-- nothing happens, so they work from memory and work differently, which is the
-- difference between an agency and a group of people sharing a login page.
--
-- Not every template though. An advisor with a habit of their own should be
-- able to keep it without pushing it onto everybody, so a template is either
-- the agency's or the advisor's, and everyone gets both. Only the agency owner
-- writes the shared ones.
--
-- The backfill makes the existing owners' templates the agency standard, which
-- is the whole point of the change: those four are what a new advisor should
-- inherit. An associate's own stay their own.

ALTER TABLE task_templates ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;

UPDATE task_templates SET shared = 1
 WHERE user_id IN (SELECT id FROM users WHERE role = 'admin');

CREATE INDEX IF NOT EXISTS idx_task_templates_shared
  ON task_templates (user_id, shared);
