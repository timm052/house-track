-- 0012:
--  • Statements of Information are read automatically: downloaded if they're a link, their comparable sales,
--    indicative price and suburb median recorded (statement_read notes which documents have been read).
--  • A peak-hour estimate for drives to places, weighted by the road types along the route (peak_s).
--  • Public transport home as well as to work: leaving the place at 5pm (the home_* columns).

CREATE TABLE statement_read (
  attachment_id uuid PRIMARY KEY REFERENCES attachment ON DELETE CASCADE,
  read_at       timestamptz NOT NULL DEFAULT now(),
  found         jsonb NOT NULL DEFAULT '{}',   -- what was read: comparables, indicative price, median
  error         text                           -- why it couldn't be read (not a Statement, download refused, …)
);

ALTER TABLE comparable_sale ADD COLUMN sale_method text;
ALTER TABLE comparable_sale ADD COLUMN attachment_id uuid REFERENCES attachment ON DELETE SET NULL;
CREATE UNIQUE INDEX comparable_sale_once ON comparable_sale (campaign_id, lower(address), sold_on);

ALTER TABLE travel_estimate ADD COLUMN peak_s integer CHECK (peak_s >= 0);

ALTER TABLE transit_estimate ADD COLUMN home_depart_at timestamptz;
ALTER TABLE transit_estimate ADD COLUMN home_arrive_at timestamptz;
ALTER TABLE transit_estimate ADD COLUMN home_duration_s integer CHECK (home_duration_s >= 0);
ALTER TABLE transit_estimate ADD COLUMN home_transfers integer;
ALTER TABLE transit_estimate ADD COLUMN home_legs jsonb NOT NULL DEFAULT '[]';
-- Journeys planned before there was a journey home get planned again (with both).
UPDATE transit_estimate SET computed_at = computed_at - interval '30 days';

-- Floor plans are their own kind: never the cover, listed with the documents. Domain names floor plan images
-- <listing>_<n>_3_…, and captures before this one saved them as photos.
ALTER TABLE attachment DISABLE TRIGGER attachment_touch;
UPDATE attachment SET kind = 'floorplan'
 WHERE kind = 'photo' AND caption = 'From the listing' AND original_name ~ '^\d+_\d+_3_';
ALTER TABLE attachment ENABLE TRIGGER attachment_touch;

CREATE OR REPLACE VIEW property_cover AS
SELECT DISTINCT ON (a.property_id) a.property_id, a.id AS attachment_id
FROM attachment a
JOIN property p ON p.id = a.property_id
WHERE a.sha256 IS NOT NULL AND a.mime_type LIKE 'image/%' AND a.kind = 'photo'
ORDER BY a.property_id,
         (a.id = p.cover_photo_id) IS TRUE DESC,
         (a.caption = 'From the listing') IS TRUE DESC,
         CASE WHEN a.caption = 'From the listing' THEN a.created_at END ASC,
         a.created_at DESC;
