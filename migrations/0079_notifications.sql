-- Being told, and choosing how.
--
-- Everything due in this portal has a date and almost nothing announces
-- itself. Tasks got a morning email and a count in the sidebar; a lead's
-- follow-up date got neither, so it was invisible unless you opened the lead
-- board, which is the thing a due date exists to save you from.
--
-- The count in the sidebar stays on for everybody: it is a number on a screen
-- somebody is already looking at, and there is nothing to opt out of. The
-- three that reach further are each an advisor's own choice, because a
-- notification somebody did not ask for is the one they learn to ignore, and
-- an advisor who has learned to ignore one has learned to ignore all of them.
--
-- Defaults are what is already true. The morning email goes out today, so
-- turning it off has to be a decision rather than a side effect of this
-- migration. The bell is new but costs nothing and shows only what the drawer
-- already shows. Push is off: it cannot be on before a browser has been asked,
-- and defaulting it on would mean a permission prompt nobody invited.
ALTER TABLE users ADD COLUMN task_digest INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN alerts_feed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN push_alerts INTEGER NOT NULL DEFAULT 0;

-- When the bell was last cleared. Everything due after this is unread, which
-- is how a count of things that are not events gets a read mark at all.
ALTER TABLE users ADD COLUMN alerts_seen_at INTEGER;

-- One row per browser that has agreed to be pushed to.
--
-- Per device, not per advisor: somebody signed in on a laptop and a phone has
-- agreed twice and expects both to buzz. The endpoint is the address the push
-- service gave that browser and is unique, so a browser that re-subscribes
-- replaces its own row rather than collecting duplicates.
--
-- The keys are that browser's half of the encryption, not ours. A push is
-- encrypted to them and cannot be read by the push service in between, which
-- is why they are here rather than a token being enough.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- What the browser called itself when it subscribed, so somebody can tell
  -- their phone from their laptop when turning one off.
  label TEXT,
  last_sent_at INTEGER,
  -- A push service says gone when somebody clears their browser data. The row
  -- is kept and marked rather than deleted, so a device that comes back is
  -- recognised instead of counted twice.
  failed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id, failed_at);
