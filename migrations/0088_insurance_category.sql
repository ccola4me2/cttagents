-- Insurance becomes a category of its own.
--
-- It was never on the list, so every insurer anybody added landed in Other or
-- in nothing at all, and the one screen that exists to answer "who do we sell
-- for insurance" could not answer it.
--
-- This moves the ones that can be named without guessing. Two kinds: anything
-- with Insurance in its name, and the brands a leisure agency actually sells.
-- Deliberately not clever. A vendor this misses is one dropdown on that
-- vendor's own page; a vendor this moves wrongly is somebody hunting for a
-- tour operator that has left the shelf it was on.
--
-- Prefix patterns throughout. D1 refuses a LIKE with a wildcard followed by a
-- long literal tail, and a migration that fails halfway is worse than one that
-- catches fewer names.
--
-- Only the primary shelf. categories_json is the list a supplier was imported
-- under and is somebody's record of where it came from, not ours to rewrite.
--
-- To see what this will move before running it, swap UPDATE vendors SET
-- category = 'Insurance', updated_at = strftime('%s','now') for
-- SELECT name, category FROM vendors and run the WHERE on its own.

UPDATE vendors
   SET category = 'Insurance', updated_at = strftime('%s','now')
 WHERE name LIKE '%Insurance%'
    OR name LIKE 'Allianz%'
    OR name LIKE 'Travel Guard%'
    OR name LIKE 'AIG Travel%'
    OR name LIKE 'Travelex%'
    OR name LIKE 'Travel Insured%'
    OR name LIKE 'Generali%'
    OR name LIKE 'CSA Travel%'
    OR name LIKE 'Trawick%'
    OR name LIKE 'Seven Corners%'
    OR name LIKE 'Berkshire Hathaway Travel%'
    OR name LIKE 'TravelSafe%'
    OR name LIKE 'Tin Leg%'
    OR name LIKE 'battleface%'
    OR name LIKE 'Arch RoamRight%'
    OR name LIKE 'RoamRight%'
    OR name LIKE 'HTH Worldwide%'
    OR name LIKE 'Medjet%'
    OR name LIKE 'John Hancock%'
    OR name LIKE 'Manulife%'
    OR name LIKE 'World Nomads%'
    OR name LIKE 'SafetyWing%'
    OR name LIKE 'AXA Assistance%';
