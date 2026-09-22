-- 0005: planning overlays are streamed from the state's map service instead of downloaded (decision
-- 2026-09-22). Each house is looked up once when it's pinned and the answer is saved here, so flags,
-- filters and the grid keep working offline. School zones (small) stay local in overlay_feature.

CREATE TABLE overlay_check (
  property_id uuid PRIMARY KEY REFERENCES property ON DELETE CASCADE,
  origin      geometry(Point, 4326) NOT NULL,   -- the pin that was looked up; a moved pin is re-checked
  checked_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE overlay_lookup (
  property_id uuid NOT NULL REFERENCES property ON DELETE CASCADE,
  layer_code  text NOT NULL REFERENCES overlay_layer (code) ON UPDATE CASCADE ON DELETE CASCADE,
  label       text,
  attrs       jsonb NOT NULL DEFAULT '{}',
  looked_up_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX overlay_lookup_property_idx ON overlay_lookup (property_id);

-- Hits now come from local features (school zones) plus saved lookups that match the current pin.
CREATE OR REPLACE VIEW property_overlay_hit AS
  SELECT p.id AS property_id, l.code, l.effect, f.label, f.attrs
  FROM property p
  JOIN overlay_feature f ON ST_Intersects(f.geom, p.location)
  JOIN overlay_layer   l ON l.id = f.layer_id
  UNION ALL
  SELECT o.property_id, l.code, l.effect, o.label, o.attrs
  FROM overlay_lookup o
  JOIN overlay_layer l ON l.code = o.layer_code
  JOIN overlay_check c ON c.property_id = o.property_id
  JOIN property p ON p.id = o.property_id
  WHERE ST_Equals(c.origin, p.location);
