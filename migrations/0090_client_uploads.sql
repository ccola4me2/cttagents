-- A client can send a document in, not only take one out.
--
-- documents has been advisor to client since it was built: the advisor
-- attaches a file and decides whether the client may download it. The other
-- direction was an email with a passport photo on it, which is the thing this
-- portal exists to stop.
--
-- One column, because the advisor has to be able to tell at a glance which
-- files they attached and which ones arrived. Without it a passport scan the
-- client sent looks exactly like one the advisor typed up, and the difference
-- matters the moment anybody asks where it came from.
--
-- NOT NULL with a default, so every row already there reads as what it is:
-- something the advisor attached.

ALTER TABLE documents ADD COLUMN from_client INTEGER NOT NULL DEFAULT 0;
