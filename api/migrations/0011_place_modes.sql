-- 0011: each place says how to get there: which of walking, driving and public transport are worked out from every
-- house (the Places tab). Stations are walk-only. Turning a mode off drops its stored times (see PATCH /places).

ALTER TABLE place ADD COLUMN modes text[] NOT NULL DEFAULT '{walk,drive,transit}'
  CHECK (modes <@ '{walk,drive,transit}'::text[]);
-- A data fix, not anyone's edit: the touch trigger would demand a person for updated_by.
ALTER TABLE place DISABLE TRIGGER place_touch;
UPDATE place SET modes = '{walk}' WHERE kind = 'station';
ALTER TABLE place ENABLE TRIGGER place_touch;

CREATE OR REPLACE VIEW travel_estimate_stale AS
  SELECT pr.id AS property_id, pl.id AS place_id, m.mode
  FROM property pr
  CROSS JOIN place pl
  CROSS JOIN LATERAL unnest(CASE WHEN pl.kind = 'station' THEN ARRAY['walk']
                                 ELSE ARRAY(SELECT x FROM unnest(pl.modes) x WHERE x IN ('walk', 'drive')) END) AS m(mode)
  LEFT JOIN travel_estimate t
         ON t.property_id = pr.id AND t.place_id = pl.id AND t.mode = m.mode
  WHERE pr.location IS NOT NULL
    AND pl.archived_at IS NULL
    AND (t.property_id IS NULL
         OR NOT ST_Equals(t.origin, pr.location)
         OR NOT ST_Equals(t.destination, pl.location));

CREATE OR REPLACE VIEW transit_estimate_stale AS
  SELECT p.id AS property_id, pl.id AS place_id,
         ST_X(p.location) AS lon, ST_Y(p.location) AS lat, ST_X(pl.location) AS to_lon, ST_Y(pl.location) AS to_lat
  FROM property p
  JOIN place pl ON pl.kind = 'destination' AND pl.archived_at IS NULL AND 'transit' = ANY(pl.modes)
  WHERE p.location IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM transit_estimate t
                    WHERE t.property_id = p.id AND t.place_id = pl.id
                      AND ST_Equals(t.origin, p.location) AND ST_Equals(t.destination, pl.location)
                      AND t.computed_at > now() - interval '14 days');
