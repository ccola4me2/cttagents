-- A form sent to somebody, rather than a link posted at the world.
--
-- A hosted form has always been a public page: copy the link, put it wherever
-- people are, and whoever fills it in becomes a lead. That is right for a
-- bridal show and wrong for the commonest thing an advisor actually does,
-- which is send the planning questions to one person they have just spoken to.
--
-- Two things only a sent form can know.
--
-- Who it went to. A submission off the open link is matched to the book by
-- name, which is the best a public page can do and turns Bob Smith and Robert
-- Smith into two people. An invite carries the client it was sent to, so the
-- answers land on that record and no guessing is involved.
--
-- Whether anything happened. "Did they fill it in?" is the question the
-- advisor asks two days later, and until now the only answer was to go and
-- look through the submissions. Sent, opened and submitted are stamped here.
--
-- The id is the token in the address, so it is a randomUUID and never anything
-- derived from the client: an address that can be guessed is an address that
-- reads somebody else's answers.
CREATE TABLE IF NOT EXISTS form_invites (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  -- The advisor who sent it. The fence in this database is user_id, and an
  -- invite is read on screens scoped by it. It is also who the reply goes to.
  user_id TEXT NOT NULL,
  -- Who it was sent to, where they are already on the book. Null is allowed:
  -- sending to an address nobody has met yet is a normal thing to do, and the
  -- submission falls back to matching by name the way the open link does.
  client_id TEXT,
  email TEXT NOT NULL,
  name TEXT,
  sent_at INTEGER NOT NULL,
  -- Best effort and honest about it: opened_at is set when the page is
  -- fetched with this token, which a mail client prefetching links can also
  -- do. It says "the link was followed", not "they read it".
  opened_at INTEGER,
  submitted_at INTEGER,
  submission_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_form_invites_form ON form_invites(form_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_form_invites_user ON form_invites(user_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_form_invites_client ON form_invites(client_id);
