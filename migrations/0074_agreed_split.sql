-- What the agreement said when the reservation was taken.
--
-- The advisor's share was worked out live: COALESCE(b.advisor_split_pct,
-- u.default_split_pct, 100), reading the rate on the advisor's record at the
-- moment somebody opened a report. So lowering a split today restated what
-- that advisor kept on every trip they had ever sold and not been given a
-- figure of its own, including trips already invoiced and already paid out.
--
-- That was deliberate, and the note in split.js argued for it: changing an
-- agreement applies to every trip that has not been given its own figure,
-- which is what changing an agreement means. It is the wrong reading of an
-- agreement about money already earned. A split changes going forward. The
-- figure on a trip sold in March is what was agreed in March, and a report run
-- in September that says otherwise disagrees with the cheque.
--
-- So the agreement is stamped onto the reservation when it is taken. Both
-- halves of it, because the advisor agreement has two rates and which one
-- applies depends on lead_source, which stays editable: stamping both means
-- moving a trip between them picks the rate that was agreed rather than
-- today's.
--
-- advisor_split_pct is untouched and still means what it meant: a figure
-- written on this one trip by hand, which beats both of these.

ALTER TABLE bookings ADD COLUMN agreed_split_pct REAL;
ALTER TABLE bookings ADD COLUMN agreed_lead_split_pct REAL;

-- Every existing reservation is stamped with the rate that applies to it
-- today, so applying this moves no figure anywhere. It freezes the book as it
-- currently reads; it does not restate it. From here a change to an advisor's
-- record reaches new reservations only.
--
-- COALESCE to 100 rather than leaving null: no agreement recorded means the
-- advisor keeps what they earned, and that is as much a fact about March as
-- any other rate. A deliberate 0, which is a house account, survives because
-- COALESCE only replaces null.
UPDATE bookings
   SET agreed_split_pct = COALESCE(
         (SELECT u.default_split_pct FROM users u WHERE u.id = bookings.user_id), 100),
       agreed_lead_split_pct = COALESCE(
         (SELECT COALESCE(u.lead_split_pct, u.default_split_pct)
            FROM users u WHERE u.id = bookings.user_id), 100)
 WHERE agreed_split_pct IS NULL;
