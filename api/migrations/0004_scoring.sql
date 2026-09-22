-- 0004 milestone 6: weighted scoring against the household's own criteria (PLAN.md §5 Should).
-- Criteria and weights are shared; scores are per person and append-only like verdicts.

CREATE TABLE criterion (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  weight      smallint NOT NULL DEFAULT 3 CHECK (weight BETWEEN 1 AND 5),
  sort        integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE UNIQUE INDEX criterion_name_uq ON criterion (lower(name)) WHERE archived_at IS NULL;
CREATE TRIGGER criterion_touch BEFORE UPDATE ON criterion FOR EACH ROW EXECUTE FUNCTION touch();
CREATE TRIGGER criterion_audit AFTER INSERT OR UPDATE OR DELETE ON criterion FOR EACH ROW EXECUTE FUNCTION audit_row();

CREATE TABLE criterion_score (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  property_id  uuid NOT NULL REFERENCES property ON DELETE CASCADE,
  criterion_id uuid NOT NULL REFERENCES criterion ON DELETE CASCADE,
  person_id    uuid NOT NULL REFERENCES person,
  score        smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE INDEX criterion_score_current_idx ON criterion_score (property_id, criterion_id, person_id, created_at DESC);
CREATE TRIGGER criterion_score_append_only BEFORE UPDATE ON criterion_score FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER criterion_score_audit AFTER DELETE ON criterion_score FOR EACH ROW EXECUTE FUNCTION audit_row();

CREATE VIEW criterion_score_current AS
  SELECT DISTINCT ON (property_id, criterion_id, person_id) *
  FROM criterion_score ORDER BY property_id, criterion_id, person_id, created_at DESC, id DESC;

-- Weighted score per property and person, 0-100, over the active criteria that person has scored.
CREATE VIEW property_score AS
  SELECT s.property_id, s.person_id,
         round(100.0 * sum(c.weight * (s.score - 1)) / nullif(sum(c.weight * 4), 0))::int AS score,
         count(*) AS scored,
         (SELECT count(*) FROM criterion WHERE archived_at IS NULL) AS criteria
  FROM criterion_score_current s JOIN criterion c ON c.id = s.criterion_id AND c.archived_at IS NULL
  GROUP BY s.property_id, s.person_id;
