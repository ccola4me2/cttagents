-- Three things the agents asked for.
--
-- A group number from outside. Sold from a group (group_id) means one of the
-- agency's own blocks, which has to be set up first. Most group bookings are on a
-- vendor or TLN group the agency does not manage, so all that is wanted is the
-- name and number to put on the reservation: "TLN", "123456".
--
-- Whether the deposit comes back. Refundable or non refundable, chosen on the
-- reservation. NULL means nobody has said, which is what every older reservation
-- holds.
--
-- What came of an appointment. Marking one done and writing down what was
-- covered, so a team meeting can be looked back over.
ALTER TABLE bookings ADD COLUMN group_label TEXT;
ALTER TABLE bookings ADD COLUMN group_number TEXT;
ALTER TABLE bookings ADD COLUMN deposit_refundable TEXT;
ALTER TABLE appointments ADD COLUMN outcome TEXT;
