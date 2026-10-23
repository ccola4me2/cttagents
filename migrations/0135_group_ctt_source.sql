-- A group brought onto the Group Desk from the portal owner's own account remembers which group it came from.
--
--   ctt_group_id   the group in the owner's own account this one is a copy of
--   ctt_owner_id   whose account that is
--
-- The desk shows that group's client page (its address, whether it takes names, who has signed up) instead of
-- a second page of its own, so there is one page for the group and it is the one people already know.
ALTER TABLE travel_groups ADD COLUMN ctt_group_id TEXT;
ALTER TABLE travel_groups ADD COLUMN ctt_owner_id TEXT;

-- The copies already made: the same name and sailing in the portal owner's own account.
UPDATE travel_groups
   SET ctt_group_id = (SELECT s.id FROM travel_groups s JOIN users su ON su.id = s.user_id
                        WHERE su.platform_owner = 1 AND s.name = travel_groups.name
                          AND COALESCE(s.depart_date, '') = COALESCE(travel_groups.depart_date, '')
                          AND su.agency_id NOT IN (SELECT id FROM agencies WHERE is_desk = 1) LIMIT 1),
       ctt_owner_id = (SELECT s.user_id FROM travel_groups s JOIN users su ON su.id = s.user_id
                        WHERE su.platform_owner = 1 AND s.name = travel_groups.name
                          AND COALESCE(s.depart_date, '') = COALESCE(travel_groups.depart_date, '')
                          AND su.agency_id NOT IN (SELECT id FROM agencies WHERE is_desk = 1) LIMIT 1)
 WHERE user_id IN (SELECT id FROM users WHERE agency_id IN (SELECT id FROM agencies WHERE is_desk = 1));
