-- 0015: floor plan markups. A floor plan (an image or PDF on a house) marked up in the app: a scale set from a known
-- length, drawn lines and shapes, dimension lines, notes and real-size furniture. Each markup is a named version of
-- that plan, shared by the household; several can exist for one plan ("as listed", "our layout", "with the study").
-- Shapes are kept as the editor draws them (web/src/floorplan/), in the plan's own pixel coordinates.

CREATE TABLE floorplan_markup (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  attachment_id uuid NOT NULL REFERENCES attachment ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- The plan's pixels per metre, from a line of known length; null until the scale is set.
  px_per_m      double precision CHECK (px_per_m > 0),
  shapes        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(shapes) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE INDEX floorplan_markup_attachment_idx ON floorplan_markup (attachment_id, created_at);

CREATE TRIGGER floorplan_markup_touch BEFORE UPDATE ON floorplan_markup FOR EACH ROW EXECUTE FUNCTION touch();
CREATE TRIGGER floorplan_markup_audit AFTER INSERT OR UPDATE OR DELETE ON floorplan_markup FOR EACH ROW EXECUTE FUNCTION audit_row();
