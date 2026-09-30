-- 0018: the "To inspect" list. Houses someone has shortlisted from Rate (or added on the house page) to go and see.
-- Shared by the household; a house leaves it when someone records going to an inspection there, or by hand.
CREATE TABLE inspect_list (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  property_id uuid NOT NULL UNIQUE REFERENCES property ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL DEFAULT app_person() REFERENCES person
);
CREATE TRIGGER inspect_list_audit AFTER INSERT OR UPDATE OR DELETE ON inspect_list FOR EACH ROW EXECUTE FUNCTION audit_row();
