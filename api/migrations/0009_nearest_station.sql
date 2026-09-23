-- 0009: every house's nearest train station, worked out automatically from all the region's stations (the
-- station table, from OpenStreetMap) instead of only the ones picked on the Places screen. The worker routes a
-- walk and a drive from each pinned house to its three closest stations as the crow flies; the nearest is the
-- shortest walk (or, where every walk is too far, the shortest drive). Stations picked on the Places screen
-- keep their own walking times, shown as extra rows on the house page.

CREATE TABLE station_access (
  property_id    uuid NOT NULL REFERENCES property ON DELETE CASCADE,
  station_osm_id bigint NOT NULL REFERENCES station ON DELETE CASCADE,
  mode           text NOT NULL CHECK (mode IN ('walk', 'drive')),
  origin         geometry(Point, 4326) NOT NULL,   -- the pin it was routed from; a moved pin is routed again
  distance_m     integer CHECK (distance_m >= 0),
  duration_s     integer CHECK (duration_s >= 0),  -- NULL: no route (e.g. too far to walk)
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, station_osm_id, mode),
  CHECK ((distance_m IS NULL) = (duration_s IS NULL))
);

CREATE VIEW property_nearest_station AS
  SELECT DISTINCT ON (w.property_id)
         w.property_id, s.osm_id AS station_osm_id, s.name,
         ST_X(s.location) AS lon, ST_Y(s.location) AS lat,
         w.distance_m AS walk_m, w.duration_s AS walk_s, d.distance_m AS drive_m, d.duration_s AS drive_s
  FROM station_access w
  JOIN property p ON p.id = w.property_id AND ST_Equals(w.origin, p.location)
  JOIN station s ON s.osm_id = w.station_osm_id
  LEFT JOIN station_access d ON d.property_id = w.property_id AND d.station_osm_id = w.station_osm_id AND d.mode = 'drive'
  WHERE w.mode = 'walk' AND (w.duration_s IS NOT NULL OR d.duration_s IS NOT NULL)
  ORDER BY w.property_id, w.duration_s NULLS LAST, d.duration_s NULLS LAST;

-- Work queue: pinned houses with no station times from where the pin is now.
CREATE VIEW station_access_stale AS
  SELECT p.id AS property_id, ST_X(p.location) AS lon, ST_Y(p.location) AS lat
  FROM property p
  WHERE p.location IS NOT NULL
    AND EXISTS (SELECT 1 FROM station)
    AND NOT EXISTS (SELECT 1 FROM station_access a WHERE a.property_id = p.id AND ST_Equals(a.origin, p.location));
