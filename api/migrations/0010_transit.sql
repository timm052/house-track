-- 0010: public transport to each destination (Work and the other places on the Places screen), from Transitous
-- (a free, community-run journey planner over the published timetables: PTV and V/Line here). The worker plans a
-- journey arriving by 9am on the next weekday, keeps its legs so odd answers are visible, and plans it again after
-- 14 days (timetables change) or when either end moves.

CREATE TABLE transit_estimate (
  property_id  uuid NOT NULL REFERENCES property ON DELETE CASCADE,
  place_id     uuid NOT NULL REFERENCES place ON DELETE CASCADE,
  origin       geometry(Point, 4326) NOT NULL,
  destination  geometry(Point, 4326) NOT NULL,
  arrive_by    timestamptz NOT NULL,          -- the weekday 9am the journey was planned for
  depart_at    timestamptz,
  arrive_at    timestamptz,
  duration_s   integer CHECK (duration_s >= 0), -- NULL: no journey found
  transfers    integer,
  legs         jsonb NOT NULL DEFAULT '[]',    -- [{mode, name, minutes, from, to}]
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, place_id)
);

CREATE VIEW transit_estimate_stale AS
  SELECT p.id AS property_id, pl.id AS place_id,
         ST_X(p.location) AS lon, ST_Y(p.location) AS lat, ST_X(pl.location) AS to_lon, ST_Y(pl.location) AS to_lat
  FROM property p
  JOIN place pl ON pl.kind = 'destination' AND pl.archived_at IS NULL
  WHERE p.location IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM transit_estimate t
                    WHERE t.property_id = p.id AND t.place_id = pl.id
                      AND ST_Equals(t.origin, p.location) AND ST_Equals(t.destination, pl.location)
                      AND t.computed_at > now() - interval '14 days');
