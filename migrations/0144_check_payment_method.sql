-- How a check was paid, and the trace number of an ACH payment.
--
-- Most of what arrives is a check, but a growing share is an ACH or a wire, and those come with a trace number that is the only way to find
-- the deposit at the bank. payment_method is check, ach, wire or other; empty means it was recorded before this was asked, and is not
-- guessed. trace_number is free text, kept as typed.
ALTER TABLE commission_checks ADD COLUMN payment_method TEXT;
ALTER TABLE commission_checks ADD COLUMN trace_number TEXT;
