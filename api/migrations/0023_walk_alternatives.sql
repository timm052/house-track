-- 0023: other ways to walk to the station, with their own hills, so a walk with less climbing can be found: the routing
-- engine's alternatives and its "avoid hills" route, each profiled like the usual way. NULL until (re)profiled; walks
-- profiled before this get their alternatives on the worker's next passes.
ALTER TABLE walk_profile ADD COLUMN alternatives jsonb;

-- The view lists walk_profile's columns as they were when it was made: again, with the new one.
CREATE OR REPLACE VIEW property_station_walk AS
  SELECT n.property_id, n.name AS station, w.*
  FROM property_nearest_station n
  JOIN property p ON p.id = n.property_id
  JOIN walk_profile w ON w.key = walk_key(p.location, ST_SetSRID(ST_MakePoint(n.lon, n.lat), 4326));
