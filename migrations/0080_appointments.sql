-- An appointment: a time set aside with somebody.
--
-- Tasks already carry a date and a time, and an appointment is nearly one.
-- What it is not is a due date. A task is due by a moment; an appointment
-- occupies one, from a time until a time, somewhere, with a person who is
-- expecting you. A calendar built on due dates is a list of deadlines drawn on
-- a grid, which is not a diary and does not answer "am I free at two".
--
-- A lead needs no separate column. A lead here is a client row with a stage on
-- it, so client_id covers both, and an appointment made with a lead keeps
-- pointing at the same person after they book.
--
-- Dates and times are written the way the rest of this database writes them:
-- a plain day and a plain clock time, in the advisor's own day. No zone is
-- stored because none is asked for, and inventing one would mean a time that
-- is right in the database and wrong on the screen of the person who typed it.
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  -- Who it is with. A client or a lead, which are the same table, or nobody:
  -- an hour blocked out to write proposals is still an hour that is not free.
  client_id TEXT,
  booking_id TEXT,
  on_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  -- Allowed to be missing. "Two o'clock" is how people actually book each
  -- other, and refusing to save until somebody guesses an end time is the
  -- portal asking for precision it does not need.
  end_time TEXT,
  -- Where, in whatever words suit: a room, an address, a phone number, a
  -- meeting link. Nothing parses this and nothing should.
  location TEXT,
  kind TEXT,
  notes TEXT,
  -- Kept rather than deleted. "We cancelled that" is a thing that happened and
  -- is worth being able to see, and a cancelled hour that vanishes looks like
  -- an hour nobody ever booked.
  cancelled_at INTEGER,
  done_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The two questions asked of this table: what is in my diary between these
-- dates, and what is in it with this person.
CREATE INDEX IF NOT EXISTS idx_appointments_when ON appointments(user_id, on_date, start_time);
CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id, on_date);
