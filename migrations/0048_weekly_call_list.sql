-- The Monday email that makes Who to call worth having.
--
-- The page is right there and answers a real question, and it still has to be
-- remembered. Everything else that earns money in this portal has a deadline
-- pushing it: a payment is due, a document is missing, a client is waiting.
-- Ringing somebody who has gone quiet has nothing pushing it at all, which is
-- exactly why it never happens and exactly why it is the best lead on the
-- books. An email once a week is the push.
--
-- On by default, like the daily task digest, because a call list nobody is
-- told about is the problem this is meant to solve rather than a version of
-- it. There is a switch in Settings for anybody who disagrees.
--
-- The stamp is per advisor rather than one date for the whole agency: they are
-- sent one at a time and a run that fails half way through should finish the
-- rest next tick, not skip them for a week.

ALTER TABLE users ADD COLUMN weekly_call_list INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN call_list_sent_at INTEGER;
