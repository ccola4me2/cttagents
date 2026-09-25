-- Rows belonging to reservations that are gone.
--
-- Deleting a reservation ran one statement, against bookings. Everything on
-- the trip stayed: the travellers, the pricing lines, the payment schedule,
-- the options, the documents, the itinerary. Nothing ever looked wrong,
-- because every screen reads these tables through the booking they hang off,
-- so a pricing line with no reservation is invisible to the commission page
-- and an orphaned receipt adds to nobody's total. Invisible is not the same as
-- absent, and the live book was carrying six travellers and fifteen pricing
-- lines from reservations deleted months ago.
--
-- The code no longer leaves them; see deleteBooking and BOOKING_OWNED. This is
-- the ones already there.
--
-- Written as NOT EXISTS against bookings rather than as a list of ids, so it
-- is true whenever it runs and does nothing the second time. Every statement
-- names booking_id IS NOT NULL first: a task against a client rather than a
-- trip, and a document not yet attached to one, both have a null there and
-- neither is an orphan.
--
-- client_credits is the one that is nulled rather than deleted, at the bottom,
-- and for the reason the code gives: a credit belongs to the client. It was
-- going to be spent on that trip and now it will be spent on another one.
-- Deleting it here would take money off a client because a reservation they
-- never took was tidied up.

DELETE FROM travellers
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = travellers.booking_id);

DELETE FROM booking_pricing
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = booking_pricing.booking_id);

DELETE FROM booking_payments
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = booking_payments.booking_id);

DELETE FROM amenities
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = amenities.booking_id);

DELETE FROM penalty_tiers
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = penalty_tiers.booking_id);

DELETE FROM quote_options
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = quote_options.booking_id);

DELETE FROM components
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = components.booking_id);

DELETE FROM documents
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = documents.booking_id);

DELETE FROM itinerary_items
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = itinerary_items.booking_id);

DELETE FROM tasks
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = tasks.booking_id);

DELETE FROM trip_messages
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = trip_messages.booking_id);

DELETE FROM reviews
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = reviews.booking_id);

DELETE FROM commission_receipts
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = commission_receipts.booking_id);

DELETE FROM group_registrations
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = group_registrations.booking_id);

-- Handed back to the client rather than destroyed.
UPDATE client_credits
   SET booking_id = NULL
 WHERE booking_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = client_credits.booking_id);
