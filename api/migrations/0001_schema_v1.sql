-- 0001 schema v1: the domain model as signed off in PLAN.md (2026-09-22). PostgreSQL 18 + PostGIS 3.6.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── identity & attribution ───────────────────────────────────────────
CREATE TABLE person (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  display_name text NOT NULL UNIQUE,
  colour       text NOT NULL CHECK (colour ~ '^#[0-9a-f]{6}$'),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The API runs SET LOCAL app.person_id = '<uuid>' at the start of every write transaction.
CREATE FUNCTION app_person() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.person_id', true), '')::uuid $$;

CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := app_person();      -- NOT NULL column rejects unattributed writes
  RETURN NEW;
END $$;

CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; insert a new row', TG_TABLE_NAME;
END $$;

CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  person_id  uuid REFERENCES person,
  table_name text NOT NULL,
  row_id     text,
  op         char(1) NOT NULL CHECK (op IN ('I','U','D')),
  old_row    jsonb,
  new_row    jsonb
);
CREATE INDEX audit_log_row_idx ON audit_log (table_name, row_id, at);

CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o jsonb; n jsonb; r jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  r := coalesce(n, o);
  INSERT INTO audit_log (person_id, table_name, row_id, op, old_row, new_row)
  VALUES (app_person(), TG_TABLE_NAME, coalesce(r ->> 'id', r ->> 'key'), left(TG_OP, 1), o, n);
  RETURN NULL;
END $$;

CREATE TABLE household_setting (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),   -- e.g. 'walk_limit_min'
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);

-- ─── development (building or estate) ─────────────────────────────────
CREATE TABLE development (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  name                text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('apartment_building','townhouse_complex','estate')),
  developer           text,
  plan_number         text,
  expected_completion date,
  location            geometry(Point, 4326),
  footprint           geometry(MultiPolygon, 4326) CHECK (footprint IS NULL OR ST_IsValid(footprint)),
  notes               text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE INDEX development_footprint_gix ON development USING gist (footprint);

-- ─── property ─────────────────────────────────────────────────────────
CREATE TABLE property (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  address_key        text NOT NULL UNIQUE,
  gnaf_pid           text UNIQUE,
  plan_number        text,                -- format validated by the region pack
  lot_number         text,
  development_id     uuid REFERENCES development ON DELETE SET NULL,
  build_status       text NOT NULL DEFAULT 'established'
                     CHECK (build_status IN ('established','off_the_plan','under_construction')),
  unit               text,
  street_number      text,
  street             text,
  suburb             text NOT NULL,
  postcode           char(4) NOT NULL CHECK (postcode ~ '^[0-9]{4}$'),
  property_type      text NOT NULL DEFAULT 'house'
                     CHECK (property_type IN ('house','townhouse','unit','apartment','land','other')),
  beds               smallint CHECK (beds BETWEEN 0 AND 20),
  baths              smallint CHECK (baths BETWEEN 0 AND 20),
  car_spaces         smallint CHECK (car_spaces BETWEEN 0 AND 20),
  land_m2            integer  CHECK (land_m2 > 0),
  building_m2        integer  CHECK (building_m2 > 0),
  geocoded_location  geometry(Point, 4326),
  geocode_source     text CHECK (geocode_source IN ('gnaf','nominatim','listing')),
  geocode_confidence real CHECK (geocode_confidence BETWEEN 0 AND 1),
  geocode_detail     jsonb,
  manual_location    geometry(Point, 4326),
  manual_location_by uuid REFERENCES person,
  location           geometry(Point, 4326)
                     GENERATED ALWAYS AS (coalesce(manual_location, geocoded_location)) STORED,
  owners_corp_fees_aud_pa integer CHECK (owners_corp_fees_aud_pa >= 0),
  council_rates_aud_pa    integer CHECK (council_rates_aud_pa >= 0),
  notes              text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  UNIQUE (plan_number, lot_number),
  CHECK ((plan_number IS NULL) = (lot_number IS NULL)),
  CHECK ((street_number IS NOT NULL AND street IS NOT NULL) OR plan_number IS NOT NULL),
  CHECK ((manual_location IS NULL) = (manual_location_by IS NULL)),
  CHECK ((geocoded_location IS NULL) = (geocode_source IS NULL))
);
CREATE INDEX property_location_gix    ON property USING gist (location);
CREATE INDEX property_address_trgm    ON property USING gin (address_key gin_trgm_ops);
CREATE INDEX property_development_idx ON property (development_id);

-- ─── agents ───────────────────────────────────────────────────────────
CREATE TABLE agency (
  id      uuid PRIMARY KEY DEFAULT uuidv7(),
  name    text NOT NULL,
  office  text,
  phone   text,
  website text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  UNIQUE NULLS NOT DISTINCT (name, office)
);

CREATE TABLE agent (
  id        uuid PRIMARY KEY DEFAULT uuidv7(),
  agency_id uuid REFERENCES agency ON DELETE SET NULL,
  name      text NOT NULL,
  mobile    text,
  email     text,
  notes     text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);

-- ─── campaign (listing) + outcome ─────────────────────────────────────
CREATE TABLE campaign (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  property_id           uuid NOT NULL REFERENCES property ON DELETE CASCADE,
  continues_campaign_id uuid REFERENCES campaign ON DELETE SET NULL,
  sale_method           text NOT NULL CHECK (sale_method IN ('auction','eoi','private_sale','other')),
  listed_on             date,
  auction_at            timestamptz,
  eoi_closes_at         timestamptz,
  outcome               text CHECK (outcome IN ('sold_prior','sold_at_auction','sold_after_auction','sold',
                                                'passed_in','withdrawn','disappeared')),
  outcome_on            date,
  sold_price_aud        integer CHECK (sold_price_aud > 0),
  passed_in_bid_aud     integer CHECK (passed_in_bid_aud > 0),
  bought_by_us          boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  UNIQUE (id, property_id),
  CHECK (auction_at IS NULL OR sale_method = 'auction'),
  CHECK (eoi_closes_at IS NULL OR sale_method = 'eoi'),
  CHECK ((outcome IS NULL) = (outcome_on IS NULL)),
  CHECK (sold_price_aud IS NULL OR outcome LIKE 'sold%'),
  CHECK (passed_in_bid_aud IS NULL OR sale_method = 'auction'),
  CHECK (NOT bought_by_us OR outcome LIKE 'sold%')
);
CREATE UNIQUE INDEX campaign_one_live_per_property ON campaign (property_id) WHERE outcome IS NULL;
CREATE INDEX campaign_auction_at_idx ON campaign (auction_at) WHERE auction_at IS NOT NULL;

CREATE TABLE campaign_agent (
  campaign_id uuid REFERENCES campaign ON DELETE CASCADE,
  agent_id    uuid REFERENCES agent ON DELETE RESTRICT,
  is_lead     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (campaign_id, agent_id)
);
CREATE UNIQUE INDEX campaign_one_lead_agent ON campaign_agent (campaign_id) WHERE is_lead;

CREATE TABLE campaign_link (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  campaign_id     uuid NOT NULL REFERENCES campaign ON DELETE CASCADE,
  portal          text NOT NULL CHECK (portal IN ('domain','rea','agency','other')),
  url             text NOT NULL UNIQUE,
  external_id     text,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  UNIQUE (portal, external_id)
);

-- ─── money (append-only) ──────────────────────────────────────────────
CREATE TABLE price_guide (
  id                          uuid PRIMARY KEY DEFAULT uuidv7(),
  campaign_id                 uuid NOT NULL REFERENCES campaign ON DELETE CASCADE,
  source                      text NOT NULL CHECK (source IN ('price_statement','advertised','agent_verbal','other')),
  low_aud                     integer NOT NULL CHECK (low_aud > 0),
  high_aud                    integer NOT NULL,
  statement_suburb_median_aud integer CHECK (statement_suburb_median_aud > 0),
  observed_at                 timestamptz NOT NULL DEFAULT now(),
  note                        text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  CHECK (high_aud >= low_aud)
);
CREATE INDEX price_guide_campaign_idx ON price_guide (campaign_id, observed_at);

CREATE TABLE price_judgement (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  campaign_id uuid NOT NULL REFERENCES campaign ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('estimated_reserve','expected_sale','walk_away')),
  amount_aud  integer NOT NULL CHECK (amount_aud > 0),   -- always the joint figure
  note        text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE INDEX price_judgement_current_idx ON price_judgement (campaign_id, kind, created_at DESC);

-- ─── opinions & status (append-only) ──────────────────────────────────
CREATE TABLE opinion (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),   -- normally client-generated
  property_id uuid NOT NULL REFERENCES property ON DELETE CASCADE,
  campaign_id uuid,
  person_id   uuid NOT NULL REFERENCES person,
  stage       text NOT NULL CHECK (stage IN ('pre_inspection','post_inspection')),
  stance      text NOT NULL CHECK (stance IN ('yes','maybe','no')),
  note        text,
  recorded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  FOREIGN KEY (campaign_id, property_id) REFERENCES campaign (id, property_id) ON DELETE SET NULL (campaign_id)
);
CREATE INDEX opinion_current_idx ON opinion (property_id, person_id, stage, recorded_at DESC);

CREATE TABLE status_event (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  property_id uuid NOT NULL REFERENCES property ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('watching','inspecting','shortlisted','bidding',
                                              'rejected','lost','withdrawn','bought')),
  reason      text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE INDEX status_event_property_idx ON status_event (property_id, occurred_at DESC);

-- ─── inspections ──────────────────────────────────────────────────────
CREATE TABLE inspection (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  property_id uuid NOT NULL REFERENCES property ON DELETE CASCADE,
  campaign_id uuid,
  kind        text NOT NULL CHECK (kind IN ('open','private','second_look','building_pest',
                                            'display_suite','pre_settlement','other')),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  state       text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','attended','skipped','cancelled')),
  inspector   text,
  notes       text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  FOREIGN KEY (campaign_id, property_id) REFERENCES campaign (id, property_id) ON DELETE SET NULL (campaign_id)
);
CREATE INDEX inspection_starts_idx   ON inspection (starts_at);
CREATE INDEX inspection_property_idx ON inspection (property_id);

CREATE TABLE inspection_attendee (
  inspection_id uuid REFERENCES inspection ON DELETE CASCADE,
  person_id     uuid REFERENCES person,
  note          text,
  PRIMARY KEY (inspection_id, person_id)
);

-- ─── areas & overlays ─────────────────────────────────────────────────
CREATE TABLE area (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id    uuid NOT NULL DEFAULT app_person() REFERENCES person,   -- the area applies to this person only
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('hard_exclude','soft_warn')),
  reason      text,
  geom        geometry(MultiPolygon, 4326) NOT NULL CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom)),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE INDEX area_geom_gix  ON area USING gist (geom);
CREATE INDEX area_owner_idx ON area (owner_id);

CREATE TABLE overlay_layer (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  code        text NOT NULL UNIQUE,
  title       text NOT NULL,
  effect      text NOT NULL DEFAULT 'info' CHECK (effect IN ('info','soft_warn','hard_exclude')),
  source_url  text,
  licence     text,
  data_as_of  date,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE overlay_feature (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  layer_id uuid NOT NULL REFERENCES overlay_layer ON DELETE CASCADE,
  label    text,
  attrs    jsonb NOT NULL DEFAULT '{}',
  geom     geometry(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX overlay_feature_geom_gix  ON overlay_feature USING gist (geom);
CREATE INDEX overlay_feature_layer_idx ON overlay_feature (layer_id);

-- ─── stations, places, travel ─────────────────────────────────────────
-- Filled by the setup job from the region's OpenStreetMap extract. Setup upserts; it never deletes a
-- station a place still points to.
CREATE TABLE station (
  osm_id       bigint PRIMARY KEY,
  name         text NOT NULL,
  location     geometry(Point, 4326) NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX station_location_gix ON station USING gist (location);
CREATE INDEX station_name_trgm    ON station USING gin (name gin_trgm_ops);

CREATE TABLE place (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  kind           text NOT NULL CHECK (kind IN ('station','destination')),
  name           text NOT NULL,
  station_osm_id bigint UNIQUE REFERENCES station ON DELETE RESTRICT,
  person_id      uuid REFERENCES person,     -- optional label ("A's work"); everyone still sees it
  location       geometry(Point, 4326) NOT NULL,
  archived_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  CHECK ((kind = 'station') = (station_osm_id IS NOT NULL))
);
CREATE INDEX place_location_gix ON place USING gist (location);

-- System-maintained cache of routing-engine results; not audited.
CREATE TABLE travel_estimate (
  property_id uuid NOT NULL REFERENCES property ON DELETE CASCADE,
  place_id    uuid NOT NULL REFERENCES place ON DELETE CASCADE,
  mode        text NOT NULL CHECK (mode IN ('walk','drive')),
  origin      geometry(Point, 4326) NOT NULL,   -- property.location this route was computed from
  destination geometry(Point, 4326) NOT NULL,   -- place.location this route was computed to
  distance_m  integer CHECK (distance_m >= 0),
  duration_s  integer CHECK (duration_s >= 0),  -- NULL = no route found
  engine      text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, place_id, mode),
  CHECK ((distance_m IS NULL) = (duration_s IS NULL))
);
CREATE INDEX travel_estimate_place_idx ON travel_estimate (place_id);

-- ─── tags, attachments, comparables ───────────────────────────────────
CREATE TABLE tag (
  id     uuid PRIMARY KEY DEFAULT uuidv7(),
  name   text NOT NULL,
  colour text CHECK (colour ~ '^#[0-9a-f]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE UNIQUE INDEX tag_name_uq ON tag (lower(name));

CREATE TABLE property_tag (
  property_id uuid REFERENCES property ON DELETE CASCADE,
  tag_id      uuid REFERENCES tag ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  PRIMARY KEY (property_id, tag_id)
);
CREATE INDEX property_tag_tag_idx ON property_tag (tag_id);

CREATE TABLE attachment (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  property_id    uuid NOT NULL REFERENCES property ON DELETE CASCADE,
  campaign_id    uuid,
  inspection_id  uuid REFERENCES inspection ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN ('photo','floorplan','price_statement','vendor_statement','contract',
                                               'building_report','pest_report','strata_report',
                                               'strata_certificate','plans_specs','other')),
  sha256         char(64) CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type      text,
  byte_size      bigint CHECK (byte_size >= 0),
  original_name  text,
  url            text,
  caption        text,
  taken_at       timestamptz,
  taken_location geometry(Point, 4326),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  CHECK (num_nonnulls(sha256, url) = 1),
  CHECK ((sha256 IS NULL) = (mime_type IS NULL)),
  CHECK (kind NOT IN ('price_statement','vendor_statement','contract') OR campaign_id IS NOT NULL),
  FOREIGN KEY (campaign_id, property_id) REFERENCES campaign (id, property_id) ON DELETE SET NULL (campaign_id)
);
CREATE INDEX attachment_property_idx ON attachment (property_id, kind);
CREATE INDEX attachment_sha_idx      ON attachment (sha256);

CREATE TABLE comparable_sale (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  campaign_id      uuid NOT NULL REFERENCES campaign ON DELETE CASCADE,
  source           text NOT NULL CHECK (source IN ('price_statement','own_research')),
  address          text NOT NULL,
  comp_property_id uuid REFERENCES property ON DELETE SET NULL,
  location         geometry(Point, 4326),
  sold_price_aud   integer CHECK (sold_price_aud > 0),
  sold_on          date,
  beds smallint, baths smallint, car_spaces smallint, land_m2 integer,
  note             text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE INDEX comparable_sale_campaign_idx ON comparable_sale (campaign_id);
CREATE INDEX comparable_sale_location_gix ON comparable_sale USING gist (location);

-- ─── triggers ─────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['household_setting','development','property','agency','agent','campaign',
                           'inspection','area','place','attachment','comparable_sale'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION touch()', t);
    EXECUTE format('CREATE TRIGGER %1$s_audit AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['price_guide','price_judgement','opinion','status_event'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_append_only BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION append_only()', t);
    EXECUTE format('CREATE TRIGGER %1$s_audit AFTER DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['campaign_link','campaign_agent','inspection_attendee','tag','property_tag'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_audit AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;

-- ─── derived reads ────────────────────────────────────────────────────
CREATE VIEW opinion_current AS
  SELECT DISTINCT ON (property_id, person_id, stage) *
  FROM opinion ORDER BY property_id, person_id, stage, recorded_at DESC, id DESC;

CREATE VIEW price_judgement_current AS
  SELECT DISTINCT ON (campaign_id, kind) *
  FROM price_judgement ORDER BY campaign_id, kind, created_at DESC, id DESC;

CREATE VIEW property_status AS
  SELECT p.id AS property_id, coalesce(s.status, 'watching') AS status, s.occurred_at, s.created_by
  FROM property p
  LEFT JOIN LATERAL (SELECT status, occurred_at, created_by FROM status_event e
                     WHERE e.property_id = p.id
                     ORDER BY occurred_at DESC, id DESC LIMIT 1) s ON true;

CREATE VIEW property_overlay_hit AS
  SELECT p.id AS property_id, l.code, l.effect, f.label, f.attrs
  FROM property p
  JOIN overlay_feature f ON ST_Intersects(f.geom, p.location)
  JOIN overlay_layer   l ON l.id = f.layer_id;

-- Every area hit, with its owner; drives the "flagged by A" badges.
CREATE VIEW property_area_hit AS
  SELECT p.id AS property_id, a.id AS area_id, a.owner_id, a.kind, a.name
  FROM property p
  JOIN area a ON a.archived_at IS NULL AND ST_Intersects(a.geom, p.location);

-- Flags as they apply to each person: their own areas plus household-wide overlays.
CREATE VIEW property_flags AS
  WITH hits AS (
    SELECT property_id, owner_id AS applies_to, kind AS effect, name AS label
    FROM property_area_hit
    UNION ALL
    SELECT property_id, NULL, effect, coalesce(label, code)
    FROM property_overlay_hit WHERE effect <> 'info'
  )
  SELECT p.id AS property_id, pe.id AS person_id,
         coalesce(bool_or(h.effect = 'hard_exclude'), false) AS excluded,
         coalesce(bool_or(h.effect = 'soft_warn'), false)    AS warned,
         array_remove(array_agg(h.label ORDER BY h.label), NULL) AS reasons
  FROM property p
  CROSS JOIN person pe
  LEFT JOIN hits h ON h.property_id = p.id AND (h.applies_to IS NULL OR h.applies_to = pe.id)
  WHERE pe.active
  GROUP BY p.id, pe.id;

-- Walking access to designated stations. The UI shows rows where is_nearest OR within_limit.
CREATE VIEW property_station_access AS
  SELECT t.property_id, pl.id AS place_id, pl.name, t.distance_m, t.duration_s,
         row_number() OVER (PARTITION BY t.property_id ORDER BY t.duration_s) = 1 AS is_nearest,
         t.duration_s <= 60 * coalesce((SELECT (value #>> '{}')::int FROM household_setting
                                        WHERE key = 'walk_limit_min'), 20) AS within_limit
  FROM travel_estimate t
  JOIN place pl ON pl.id = t.place_id AND pl.kind = 'station' AND pl.archived_at IS NULL
  WHERE t.mode = 'walk' AND t.duration_s IS NOT NULL;

-- Work queue for the routing job: missing routes, or routes computed from points that have since moved.
-- Stations get walking only; destinations get walking and driving.
CREATE VIEW travel_estimate_stale AS
  SELECT pr.id AS property_id, pl.id AS place_id, m.mode
  FROM property pr
  CROSS JOIN place pl
  CROSS JOIN LATERAL unnest(CASE WHEN pl.kind = 'station' THEN ARRAY['walk']
                                 ELSE ARRAY['walk','drive'] END) AS m(mode)
  LEFT JOIN travel_estimate t
         ON t.property_id = pr.id AND t.place_id = pl.id AND t.mode = m.mode
  WHERE pr.location IS NOT NULL
    AND pl.archived_at IS NULL
    AND (t.property_id IS NULL
         OR NOT ST_Equals(t.origin, pr.location)
         OR NOT ST_Equals(t.destination, pl.location));
