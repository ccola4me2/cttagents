-- The automation partition becomes the agency.
--
-- `location_id` on these five tables held a GoHighLevel sub-account id.
-- GoHighLevel was dropped on 2026-09-13 and the key stayed behind, still
-- deciding which advisors an automation or a form reaches. It answered that
-- question wrongly in both directions:
--
--   Too wide. An advisor with no sub-account of their own resolved to a single
--   shared GHL_DEFAULT_LOCATION_ID, so every such advisor sat in one bucket
--   together. The payment sweep then fired one advisor's automations against
--   another's clients, which is the exact thing the comment above that query
--   says must never happen.
--
--   Too narrow. The cron swept only that shared bucket, so an advisor who did
--   have a sub-account of their own got no time based automations at all.
--
-- The fence has been users.agency_id since 2026-09-07. This puts the partition
-- on it. The column is renamed rather than left lying: a column called
-- location_id holding an agency id is worse than either name on its own, and
-- RENAME COLUMN is a metadata edit, not a table rebuild.
--
-- Applying this is not optional. The Worker selects agency_id from these
-- tables, so until it runs, Automations and Lead forms return an error naming
-- this file, which is the intended way to find out rather than a surprise.

ALTER TABLE automations      RENAME COLUMN location_id TO agency_id;
ALTER TABLE automation_runs  RENAME COLUMN location_id TO agency_id;
ALTER TABLE forms            RENAME COLUMN location_id TO agency_id;
ALTER TABLE form_submissions RENAME COLUMN location_id TO agency_id;
ALTER TABLE crm_contacts     RENAME COLUMN location_id TO agency_id;

-- An automation and a form each know who made them, so each takes its owner's
-- agency. A row whose owner is gone keeps the old value on purpose: no user
-- resolves to it, so it never fires again, which is the right answer for an
-- automation nobody owns.
UPDATE automations
   SET agency_id = COALESCE(
         NULLIF((SELECT u.agency_id FROM users u WHERE u.id = automations.created_by), ''),
         agency_id)
 WHERE created_by IS NOT NULL;

UPDATE forms
   SET agency_id = COALESCE(
         NULLIF((SELECT u.agency_id FROM users u WHERE u.id = forms.created_by), ''),
         agency_id)
 WHERE created_by IS NOT NULL;

-- A run belongs to its automation and a submission to its form, so neither
-- needs an owner of its own. These follow the two above and must run after
-- them.
UPDATE automation_runs
   SET agency_id = COALESCE(
         (SELECT a.agency_id FROM automations a WHERE a.id = automation_runs.automation_id),
         agency_id);

UPDATE form_submissions
   SET agency_id = COALESCE(
         (SELECT f.agency_id FROM forms f WHERE f.id = form_submissions.form_id),
         agency_id);

-- The contacts carried over from the CRM have no owner at all: that is the
-- open question this portal has never been able to answer, and it is not
-- answered here. They are matched by the sub-account they came from, and
-- anything that does not match goes to the house agency, which is where every
-- one of them already was.
UPDATE crm_contacts
   SET agency_id = COALESCE(
         (SELECT a.id FROM agencies a WHERE a.ghl_location_id = crm_contacts.agency_id),
         'agency-house');

-- Indexes are left alone. SQLite rewrites an index definition when the column
-- under it is renamed, so idx_auto_loc is already (agency_id, active) and every
-- lookup below is still covered. Only their names now read oddly, and renaming
-- five indexes on a live database to fix a name is not a trade worth making.
