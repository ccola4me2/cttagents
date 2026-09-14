-- Values the portal decides for itself and must not forget.
--
-- Written for one of them: the secret that signs unsubscribe links. That key
-- has to be stable for years, because a link signed today is clicked whenever
-- somebody gets round to it, and it has to be secret, because anybody holding
-- it can mint a valid unsubscribe for any address on any agency's list.
--
-- Every candidate the Worker already had fails one of those. The Resend key and
-- the CRM token are secret and are rotated for reasons that have nothing to do
-- with email preferences. A literal in the source is stable and is published on
-- GitHub, where this repository is public.
--
-- So the portal makes its own on first use and keeps it here. Nothing to set,
-- nothing to remember, nothing in the repository. An operator who would rather
-- hold it themselves still can: UNSUBSCRIBE_SECRET in the environment wins.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
