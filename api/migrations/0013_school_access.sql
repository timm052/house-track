-- 0013: getting to the zoned schools. Where each school is (DataVic's school locations, loaded by setup with the
-- zones), which government schools each house is zoned for (from the zones it sits in, matched by name), and the
-- walk there (and the drive, when the walk is over 35 minutes), worked out by the worker like the other travel times.

CREATE TABLE school (
  school_no   integer PRIMARY KEY,           -- the department's school number
  name        text NOT NULL,
  school_type text,                          -- Primary, Secondary, Pri/Sec, ...
  sector      text NOT NULL,                 -- Government, Catholic, Independent
  location    geometry(Point, 4326) NOT NULL
);
CREATE INDEX school_name_idx ON school (lower(name));

-- The primary and Year 7 schools each house is zoned for, where we know where the school is. A zone's
-- ENTITY_CODE is 1, the school number, then a two-digit campus (1475301 is school 4753), which also finds schools
-- renamed since the zones were drawn (Kyneton Secondary College is now Kyneton High School); failing that, the name.
CREATE VIEW property_zoned_school AS
  SELECT DISTINCT ON (h.property_id, h.code)
         h.property_id, CASE WHEN h.code = 'vic_school_primary' THEN 'primary' ELSE 'secondary' END AS level,
         s.school_no, s.name, s.location
  FROM property_overlay_hit h
  JOIN school s ON s.sector = 'Government'
               AND (s.school_no = CASE WHEN h.attrs->>'ENTITY_CODE' ~ '^1\d{6}$'
                                       THEN substr(h.attrs->>'ENTITY_CODE', 2, 4)::integer END
                    OR lower(s.name) = lower(h.label))
  WHERE h.code IN ('vic_school_primary', 'vic_school_secondary')
  ORDER BY h.property_id, h.code,
           (s.school_no = CASE WHEN h.attrs->>'ENTITY_CODE' ~ '^1\d{6}$' THEN substr(h.attrs->>'ENTITY_CODE', 2, 4)::integer END) DESC NULLS LAST,
           s.school_no;

CREATE TABLE school_access (
  property_id uuid NOT NULL REFERENCES property ON DELETE CASCADE,
  school_no   integer NOT NULL REFERENCES school ON DELETE CASCADE,
  origin      geometry(Point, 4326) NOT NULL,   -- the pin it was worked out from; a moved pin is worked out again
  walk_m      integer, walk_s integer,
  drive_m     integer, drive_s integer,         -- only when the walk is over 35 minutes (or there's no walk)
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, school_no)
);

CREATE VIEW school_access_stale AS
  SELECT z.property_id, z.school_no, ST_X(p.location) AS lon, ST_Y(p.location) AS lat,
         ST_X(z.location) AS to_lon, ST_Y(z.location) AS to_lat
  FROM property_zoned_school z
  JOIN property p ON p.id = z.property_id
  WHERE p.location IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM school_access a
                    WHERE a.property_id = z.property_id AND a.school_no = z.school_no AND ST_Equals(a.origin, p.location));
