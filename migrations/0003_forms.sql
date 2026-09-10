-- CTT's own forms.
--
-- The upstream form builder has no create or edit API, so forms built there
-- can only ever be read. These tables are the portal's own: built here,
-- hosted here at /f/<slug>, and submitted straight into this database.
--
-- A submission still pushes a contact upstream so messaging and automations
-- keep working, but the submission itself is owned locally and survives
-- whatever happens to that account.

CREATE TABLE IF NOT EXISTS forms (
  id            TEXT PRIMARY KEY,
  location_id   TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  headline      TEXT,
  description   TEXT,
  -- Ordered field definitions: [{key,label,type,required,options[],placeholder}]
  fields_json   TEXT NOT NULL,
  submit_label  TEXT NOT NULL DEFAULT 'Send',
  success_message TEXT,
  redirect_url  TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_forms_slug ON forms (slug);
CREATE INDEX IF NOT EXISTS idx_forms_loc ON forms (location_id, active);

CREATE TABLE IF NOT EXISTS form_submissions (
  id          TEXT PRIMARY KEY,
  form_id     TEXT NOT NULL,
  location_id TEXT NOT NULL,
  contact_id  TEXT,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  data_json   TEXT NOT NULL,
  source      TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (form_id) REFERENCES forms (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subs_form ON form_submissions (form_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subs_loc ON form_submissions (location_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subs_contact ON form_submissions (contact_id);
