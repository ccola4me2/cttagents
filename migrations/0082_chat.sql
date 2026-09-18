-- Chat inside the portal: advisors and the agency, nobody else.
--
-- Three tables, because chat is three questions. Where is the conversation
-- (channels), who is in it (channel_members), and what was said (messages).
--
-- There is no room for a client in any of this, and that is the point. A
-- thread hanging off a reservation is a place where an advisor can write "the
-- deposit is wobbling" or "I quoted this wrong" next to the booking it is
-- about. That sentence is only writable because nobody outside the agency can
-- ever read it.
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  -- The fence. Every read narrows on this, and a channel with no agency
  -- behind it is unreachable rather than visible to everyone, because a chat
  -- that fails open is one agency reading another's.
  agency_id TEXT,
  -- 'channel' is a named room, 'dm' is two people, 'record' hangs off a row.
  kind TEXT NOT NULL,
  -- Named for a room. A direct message is named by who is in it, and a record
  -- thread by the record, so both leave this null.
  name TEXT,
  topic TEXT,
  -- Two people, their ids sorted and joined, so the second attempt to open a
  -- direct message finds the first one instead of making another. Sorted
  -- because "Brent and Sam" and "Sam and Brent" are one conversation.
  dm_key TEXT,
  -- The row this hangs off: 'booking' or 'client'. A lead is a client row with
  -- a stage on it, so one kind covers both and the thread survives the lead
  -- becoming a client, which is exactly when the earlier talk matters.
  subject_kind TEXT,
  subject_id TEXT,
  -- An announcements room: everyone reads, admins write. Without it the only
  -- way to make an announcement is to say it in a room where the next message
  -- pushes it up the screen.
  post_admin_only INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  -- Denormalised on purpose: the channel list is sorted by it on every poll,
  -- and working it out from messages means a join and a max per room, several
  -- times a minute, for ever.
  last_message_at INTEGER
);

-- One conversation per pair, and one thread per record. Partial, because
-- every named room leaves both columns null and they are not all the same
-- conversation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_dm
  ON channels(dm_key) WHERE dm_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_subject
  ON channels(subject_kind, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channels_agency ON channels(agency_id, kind, last_message_at);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  -- A moment rather than a message id, the same way the bell answers "new"
  -- with alerts_seen_at. Anything later than this is unread, which needs no
  -- second table and no row per person per message.
  last_read_at INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  -- Always the real person who typed it. An admin working as an advisor is
  -- refused the composer rather than posting under a borrowed name, because a
  -- message is the one record here that cannot be quietly corrected later.
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Whose attention was asked for, as a json array of user ids, worked out
  -- when the message is written rather than when it is read: the names in a
  -- room change, and who was meant does not.
  mentions TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  -- Soft, so a reply that quotes it still makes sense and so an owner can see
  -- that something was removed rather than finding a hole.
  deleted_at INTEGER,
  deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(user_id, created_at);
