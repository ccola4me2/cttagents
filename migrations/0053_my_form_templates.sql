-- An advisor's own form templates.
--
-- The built-in five, now ten, cover the situations everybody meets: a stand at
-- a show, a cruise evening, the details a vendor wants. What they cannot cover
-- is the form a particular advisor sends every week, with their wording, their
-- questions and their order, because that is theirs and not a pattern.
--
-- So: build the form once, save it as a template, and start the next one from
-- it. The usual case is the same form with a new headline, for the next show
-- or the next sailing, which is a rename rather than a build.
--
-- Personal on purpose. Forms themselves are keyed to the GoHighLevel location,
-- so everybody at an agency already shares them; a template is the half-formed
-- thing an advisor is still working out how they like, and having somebody
-- else's appear in your list would be noise. Sharing them across an agency is
-- a later decision, and a column away.
--
-- The fields are stored as JSON exactly like forms.fields_json, so a template
-- and a form hold the same shape and one can be made from the other without
-- anything in between reinterpreting it.

CREATE TABLE IF NOT EXISTS form_templates (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  -- The line under the name in the picker: what this one is for, in the
  -- advisor's own words.
  blurb           TEXT,
  headline        TEXT,
  description     TEXT,
  submit_label    TEXT,
  success_message TEXT,
  fields_json     TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_form_templates_user ON form_templates (user_id, name);
