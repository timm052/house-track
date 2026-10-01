-- 0021: block analysis. For the suburbs the household picks, every property boundary from Vicmap is kept with what
-- it says about the block: its size, frontage, depth and shape, how it falls (from 1 m contours), which way the back
-- faces and its planning zone. The map's Blocks mode reads it; houses we track are matched to their block.
-- Contours, roads and zones are kept once each (by Vicmap id), shared by neighbouring suburbs.

CREATE TABLE block_suburb (
  suburb      text PRIMARY KEY,                    -- as Vicmap names it, upper case: 'ROSANNA'
  boundary    geometry(MultiPolygon, 4326),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error')),
  error       text,
  blocks      int,
  analysed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL DEFAULT app_person() REFERENCES person
);

CREATE TABLE block (
  pfi          text PRIMARY KEY,                   -- Vicmap Property's id for the property
  suburb       text NOT NULL REFERENCES block_suburb ON DELETE CASCADE,
  geom         geometry(MultiPolygon, 4326) NOT NULL,
  address      text,                               -- '12 Arden Crescent', or the first of several
  street       text,                               -- 'ARDEN CRESCENT', to find the street it faces
  is_unit      boolean NOT NULL DEFAULT false,     -- a unit's own lot in a strata subdivision
  addresses    int NOT NULL DEFAULT 1,
  area_m2      int,
  frontage_m   real,
  depth_m      real,
  regularity   real,                               -- area over its smallest enclosing rectangle: 1 is a rectangle
  battleaxe    boolean,
  front_elev   real,
  fall_m       real,                               -- back minus front: positive rises from the street
  cross_fall_m real,                               -- left minus right, looking from the street
  along_pct    real,
  across_pct   real,
  incline_pct  real,                               -- the greater of the two
  steepest_pct real,                               -- the steepest stretch from front to back
  direction    text CHECK (direction IN ('level', 'up', 'down', 'across')),
  profile      real[],                             -- ground height at nine points from front to back, metres
  rear_bearing smallint,                           -- the direction the back of the block faces, degrees from north
  zone_code    text
);
CREATE INDEX block_geom_idx ON block USING gist (geom);
CREATE INDEX block_suburb_idx ON block (suburb);

CREATE TABLE block_contour (ufi bigint PRIMARY KEY, altitude real NOT NULL, geom geometry(MultiLineString, 7855) NOT NULL);
CREATE INDEX block_contour_geom_idx ON block_contour USING gist (geom);
CREATE TABLE block_road (ufi bigint PRIMARY KEY, name text, geom geometry(MultiLineString, 7855) NOT NULL);
CREATE INDEX block_road_geom_idx ON block_road USING gist (geom);
CREATE TABLE block_zone (ufi bigint PRIMARY KEY, zone_code text, geom geometry(MultiPolygon, 7855) NOT NULL);
CREATE INDEX block_zone_geom_idx ON block_zone USING gist (geom);

-- Ground height at a point, from the contours either side of it: the nearest contour, and the nearest one at a
-- different height, weighted by distance. Approximate, but the 1 m contours make it good to about half a metre.
CREATE FUNCTION block_elevation(p geometry) RETURNS real LANGUAGE sql STABLE AS $$
  WITH near AS (SELECT altitude, ST_Distance(geom, p) AS d FROM block_contour ORDER BY geom <-> p LIMIT 16),
       one AS (SELECT altitude, d FROM near ORDER BY d LIMIT 1),
       two AS (SELECT n.altitude, n.d FROM near n, one WHERE n.altitude <> one.altitude ORDER BY n.d LIMIT 1)
  SELECT CASE WHEN two.altitude IS NULL OR one.d + two.d = 0 THEN one.altitude
              ELSE one.altitude + (two.altitude - one.altitude) * one.d / (one.d + two.d) END::real
  FROM one LEFT JOIN two ON true
$$;
