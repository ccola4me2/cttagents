-- Where an advisor wants to be told, which is not always where they sign in.
--
-- The account email is a credential: it is the thing typed into the login box
-- and the thing a password reset goes to, and people pick it for reasons that
-- have nothing to do with work. A lead arriving on a personal address at the
-- weekend is the notification working exactly as built and still being wrong.
--
-- Null means "use the account email", so an advisor who never touches it keeps
-- the behaviour they already have.

ALTER TABLE users ADD COLUMN notify_email TEXT;
