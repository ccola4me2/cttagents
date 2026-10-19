-- Clients who arrived through a form and were stamped Referral by mistake.
--
-- oneOf handed back the first channel, Referral, for any client saved without one, and the save then wrote it
-- over the channel the form had set (Website). The fix is in the code; this puts the clients it already
-- reached back. Only where the first touch is recorded as a form (source starts "Form:") and nobody has been
-- recorded as the referrer, so a person who really was sent by somebody is not touched.
--
-- Everything else labelled Referral is left exactly as it is: the portal cannot tell a real referral from one
-- the bug made, and a guessed channel is worse than a recorded one.
UPDATE clients SET source_kind = 'website'
 WHERE source_kind = 'referral'
   AND source LIKE 'Form:%'
   AND (referred_by_client_id IS NULL OR referred_by_client_id = '');
