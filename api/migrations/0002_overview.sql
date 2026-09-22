-- 0002 milestone 2.5: shared favourite places (D19) and saved grid views (D18). See PLAN.md.

ALTER TABLE place ADD COLUMN is_favourite boolean NOT NULL DEFAULT false;

-- At most five favourite places (D19); a CHECK can't count rows, so a trigger enforces it.
CREATE FUNCTION place_favourite_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_favourite AND NEW.archived_at IS NULL
     AND (SELECT count(*) FROM place WHERE is_favourite AND archived_at IS NULL AND id <> NEW.id) >= 5 THEN
    RAISE EXCEPTION 'At most five favourite places';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER place_favourite_limit BEFORE INSERT OR UPDATE OF is_favourite, archived_at ON place
  FOR EACH ROW EXECUTE FUNCTION place_favourite_limit();

-- Shared saved views for Overview and the phone Houses tab (D18).
CREATE TABLE grid_view (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  name       text NOT NULL UNIQUE,
  is_default boolean NOT NULL DEFAULT false,
  filters    jsonb NOT NULL DEFAULT '[]',   -- [{column, op, value}]
  sort       jsonb NOT NULL DEFAULT '[]',   -- [{column, dir}]
  columns    jsonb NOT NULL DEFAULT '[]',   -- visible column keys, in order
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE UNIQUE INDEX grid_view_one_default ON grid_view (is_default) WHERE is_default;
CREATE TRIGGER grid_view_touch BEFORE UPDATE ON grid_view FOR EACH ROW EXECUTE FUNCTION touch();
CREATE TRIGGER grid_view_audit AFTER INSERT OR UPDATE OR DELETE ON grid_view FOR EACH ROW EXECUTE FUNCTION audit_row();
