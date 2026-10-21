-- 0022: the hills on the walk to the station. Each walking route (a house to its nearest station, or a benchmark walk)
-- gets its ground profile from Vicmap's 1 m contours (block_elevation, 0021): heights every 10 m, the climbing each
-- way, the steepest stretches, and a rating like a running route's. Benchmarks are walks the household knows, to
-- compare with ("12 Example Street to Testvale station").

-- A route is known by its two ends, rounded to about a metre: a pin that moves gets a new profile.
CREATE FUNCTION walk_key(o geometry, t geometry) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT round(ST_X(o)::numeric, 5) || ',' || round(ST_Y(o)::numeric, 5) || '>' || round(ST_X(t)::numeric, 5) || ',' || round(ST_Y(t)::numeric, 5)
$$;

CREATE TABLE walk_profile (
  key          text PRIMARY KEY,                -- walk_key(origin, target)
  origin       geometry(Point, 4326) NOT NULL,
  target       geometry(Point, 4326) NOT NULL,
  path         geometry(LineString, 4326),
  distance_m   int,
  heights      real[],                          -- ground height every 10 m from the start, metres
  climb_to     real,                            -- metres climbed on the way there
  climb_home   real,                            -- and on the way back
  steepest_up  real,                            -- steepest 100 m going there, % (uphill)
  steepest_down real,                           -- steepest 100 m downhill going there, % (so uphill coming home)
  contours     text,                            -- '1 m' (Melbourne and towns) or '10 m' (coarser, elsewhere)
  error        text,
  computed_at  timestamptz NOT NULL DEFAULT now()
);

-- Where contours have been downloaded for walks (blocks keep their own by suburb), so a box is fetched once.
CREATE TABLE contour_cover (id bigserial PRIMARY KEY, area geometry(Polygon, 4326) NOT NULL, contours text NOT NULL DEFAULT '1 m',
                            fetched_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX contour_cover_area_idx ON contour_cover USING gist (area);

CREATE TABLE walk_benchmark (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  name       text NOT NULL,                     -- '12 Example Street to Testvale'
  origin     geometry(Point, 4326) NOT NULL,
  station    text NOT NULL,                     -- the station's name
  target     geometry(Point, 4326) NOT NULL,
  position   int NOT NULL DEFAULT 0,            -- the first is the one houses are compared with
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO walk_benchmark (name, origin, station, target, position) VALUES
  ('12 Example Street, Testvale', ST_SetSRID(ST_MakePoint(145.00000000, -37.80000000), 4326), 'Testvale',
   ST_SetSRID(ST_MakePoint(145.0000000, -37.8100000), 4326), 0);

-- Each house's walk to its nearest station, profiled once the worker has got to it.
CREATE VIEW property_station_walk AS
  SELECT n.property_id, n.name AS station, w.*
  FROM property_nearest_station n
  JOIN property p ON p.id = n.property_id
  JOIN walk_profile w ON w.key = walk_key(p.location, ST_SetSRID(ST_MakePoint(n.lon, n.lat), 4326));
