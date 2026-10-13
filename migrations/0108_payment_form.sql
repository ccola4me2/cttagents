-- The agency's card authorization form.
--
-- Clients pay the supplier, and the portal never takes a card number. Many agencies still need a
-- client to authorize a card for a deposit or a payment, and do it on a form of their own hosted
-- somewhere that holds card details properly. This is that form's address, kept per agency so a
-- quote that asks for a deposit, a payment reminder and the client's own page can point at it.
-- NULL means the agency has none and nothing about it appears.
ALTER TABLE agencies ADD COLUMN payment_form_url TEXT;
