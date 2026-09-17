-- A meeting invite, landed in the diary.
--
-- An invite is not a new kind of thing: it is an appointment somebody else
-- typed. So it goes in the same table and shows on the same calendar, and the
-- only difference is that this one can be sent again.
--
-- That resending is the whole reason for these columns. A moved meeting
-- arrives as the same invite with a later sequence number, and without
-- somewhere to recognise it, the old time would sit on the calendar looking
-- exactly as real as the new one.
ALTER TABLE appointments ADD COLUMN ics_uid TEXT;

-- Which version of it. An invite carries a sequence that counts up on every
-- change, so a delivery that arrives late and out of order can be recognised
-- as older than what is already here and left alone. Mail is not a queue and
-- does not promise to arrive in the order it was sent.
ALTER TABLE appointments ADD COLUMN ics_sequence INTEGER;

-- Who called the meeting, as the invite says. Shown rather than matched: an
-- organiser is often somebody with no record in this portal at all.
ALTER TABLE appointments ADD COLUMN organizer TEXT;

-- Where it came from, so the calendar can say "from an invite" rather than
-- presenting somebody else's meeting as something you typed.
ALTER TABLE appointments ADD COLUMN source TEXT;

-- One appointment per invite per advisor. The same meeting sent to two people
-- in the agency is two appointments, because it is in two diaries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_uid
  ON appointments(user_id, ics_uid) WHERE ics_uid IS NOT NULL;

-- The zone an advisor's day is in.
--
-- An invite says its times in UTC or against a named zone; this portal stores
-- a plain day and a plain clock time, the way somebody says them. Converting
-- between the two needs to know whose day it is. Left null until somebody says
-- otherwise, and read with a portal-wide default behind it, because guessing a
-- zone wrongly moves every meeting by hours and does it silently.
ALTER TABLE users ADD COLUMN timezone TEXT;

-- The address invites are forwarded to.
--
-- A token rather than the advisor's name, because the address is the whole
-- permission: anything arriving at it goes in that advisor's diary. Unique so
-- one cannot be issued twice, and null until somebody asks for one, so an
-- address that has never been handed out cannot be guessed at either.
ALTER TABLE users ADD COLUMN invite_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_token
  ON users(invite_token) WHERE invite_token IS NOT NULL;
