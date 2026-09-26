-- The day's length now counts the travel between stops too (owner, 2026-09-25):
-- the old default (12h30 of stops) becomes the new one (a 14h waking day), and
-- any other saved length gets the usual 1h30 of getting around added.
UPDATE "trips"
   SET "settings" = jsonb_set("settings", '{dayCapacityMin}', to_jsonb(
         CASE WHEN ("settings"->>'dayCapacityMin')::int = 750 THEN 840
              ELSE LEAST(1440, ("settings"->>'dayCapacityMin')::int + 90) END))
 WHERE jsonb_typeof("settings"->'dayCapacityMin') = 'number';
